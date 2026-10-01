package directory

import (
	"context"
	"net/url"
	"sync"
	"time"

	pb "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitycrypto"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/sso"
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// Scanner returns a complete bounded snapshot or an error, never partial publication.
type Scanner interface {
	Scan(context.Context, sqlc.WorkspaceDirectory, string) ([]Object, error)
	Validate(sqlc.WorkspaceDirectory) error
}

// Service uses the SSO keyring, positive entitlements and transaction invalidation hooks.
type Service struct {
	Identity    *sso.Service
	LDAP        Scanner
	OperatorCAs map[string]string
	// OnError reports redacted background dependency failures to root supervision.
	OnError func(error)
}

func (s *Service) now() time.Time {
	if s.Identity.Now != nil {
		return s.Identity.Now()
	}
	return time.Now()
}
func secretBinding(c sqlc.WorkspaceDirectory) identitycrypto.Binding {
	return identitycrypto.Binding{Purpose: "directory-bind", WorkspaceID: c.WorkspaceID, RecordID: c.ID, Version: c.Version}
}
func (s *Service) authorize(ctx context.Context, q *sqlc.Queries, p identitypolicy.Principal, ws uuid.UUID) error {
	if _, err := q.LockOAuthWorkspace(ctx, ws); err != nil {
		if db.IsNotFound(err) {
			return &sso.AccessError{Decision: identitypolicy.Decision{Reason: identitypolicy.ScopeDenied}}
		}
		return err
	}
	if _, err := q.LockIdentityBoundary(ctx, sqlc.LockIdentityBoundaryParams{WorkspaceID: ws, UserID: p.UserID, SessionID: p.SessionID}); err != nil {
		if db.IsNotFound(err) {
			return &sso.AccessError{Decision: identitypolicy.Decision{Reason: identitypolicy.InvalidSession}}
		}
		return err
	}
	st, err := identitypolicy.NewSQLLoader(q, s.Identity.Edition).LoadIdentityState(ctx, p.SessionID, p.UserID, ws)
	if err != nil {
		return err
	}
	decision, clockErr := s.Identity.CheckDecision(ctx, q, st, identitypolicy.ManageDirectory)
	if clockErr != nil {
		return clockErr
	}
	if !decision.Allowed {
		return &sso.AccessError{Decision: decision}
	}
	return nil
}

// View never exposes bind credentials or operator CA settings.
func View(c sqlc.WorkspaceDirectory) *pb.IdentityDirectory {
	out := &pb.IdentityDirectory{Id: c.ID.String(), WorkspaceId: c.WorkspaceID.String(), Version: uint64(max(c.Version, 0)), Enabled: c.DisabledAt == nil, Url: c.Url, BindDn: c.BindDn, BaseDn: c.BaseDn, AllowedGroupDns: c.AllowedGroupDns, SecretConfigured: len(c.BindSecretBox) > 0, LastError: c.LastError, SyncIntervalSeconds: uint32(max(c.SyncIntervalSeconds, 0)), MaxStalenessSeconds: uint32(max(c.MaxStalenessSeconds, 0))}
	if c.LastSuccessAt != nil {
		out.LastSuccessAt = timestamppb.New(*c.LastSuccessAt)
	}
	return out
}

// Get requires owner control-plane proofs and returns redacted config/status.
func (s *Service) Get(ctx context.Context, p identitypolicy.Principal, ws uuid.UUID) (*pb.IdentityDirectory, error) {
	var out *pb.IdentityDirectory
	err := s.Identity.DB.Tx(ctx, func(q *sqlc.Queries) error {
		if err := s.authorize(ctx, q, p, ws); err != nil {
			return err
		}
		c, err := q.GetWorkspaceIdentityDirectory(ctx, ws)
		if err != nil {
			return err
		}
		out = View(c)
		return nil
	})
	return out, err
}

// Put retains mappings when disabled; it never detaches suspended managed members.
func (s *Service) Put(ctx context.Context, p identitypolicy.Principal, ws uuid.UUID, req *pb.PutIdentityDirectoryRequest) (*pb.IdentityDirectory, error) {
	if req == nil || req.BindPassword != nil && (*req.BindPassword == "" || len(*req.BindPassword) > 8192) {
		return nil, sso.ErrInvalid
	}
	u, err := url.Parse(req.Url)
	if err != nil {
		return nil, sso.ErrInvalid
	}
	candidate := sqlc.WorkspaceDirectory{WorkspaceID: ws, Name: "Active Directory", Host: u.Hostname(), Url: req.Url, Port: 636, BaseDn: req.BaseDn, BindDn: req.BindDn, AllowedGroupDns: req.AllowedGroupDns, CaPem: s.OperatorCAs[u.Hostname()], SyncIntervalSeconds: 300, MaxStalenessSeconds: 3600, Version: 1}
	if s.LDAP.Validate(candidate) != nil {
		return nil, sso.ErrInvalid
	}
	var out *pb.IdentityDirectory
	err = s.Identity.DB.Tx(ctx, func(q *sqlc.Queries) error {
		if err := s.authorize(ctx, q, p, ws); err != nil {
			return err
		}
		existing, err := q.GetIdentityDirectoryForUpdate(ctx, ws)
		fresh := db.IsNotFound(err)
		if err != nil && !fresh {
			return err
		}
		if fresh && req.Version != 0 || !fresh && uint64(max(existing.Version, 0)) != req.Version {
			return sso.ErrChanged
		}
		password := ""
		if !fresh {
			raw, err := s.Identity.Keys.Open(secretBinding(existing), existing.BindSecretBox)
			if err != nil {
				return err
			}
			password = string(raw)
			candidate.ID = existing.ID
			candidate.Version = existing.Version + 1
		} else {
			candidate.ID, err = q.ReserveIdentityID(ctx)
			if err != nil {
				return err
			}
		}
		if req.BindPassword != nil {
			password = *req.BindPassword
		}
		if password == "" {
			return sso.ErrInvalid
		}
		box, err := s.Identity.Keys.Seal(secretBinding(candidate), []byte(password))
		if err != nil {
			return err
		}
		var disabled *time.Time
		if !req.Enabled {
			now := s.now()
			disabled = &now
		}
		if fresh {
			existing, err = q.CreateIdentityDirectory(ctx, sqlc.CreateIdentityDirectoryParams{ID: &candidate.ID, WorkspaceID: ws, Name: candidate.Name, Host: candidate.Host, Url: candidate.Url, AllowedGroupDns: candidate.AllowedGroupDns, Port: 636, BaseDn: candidate.BaseDn, BindDn: candidate.BindDn, BindSecretBox: box, CaPem: candidate.CaPem, SyncIntervalSeconds: 300, MaxStalenessSeconds: 3600})
			if err != nil {
				return err
			}
			// Creation's frozen query defaults enabled; disabled creation is finalized using CAS.
			if disabled != nil {
				candidate.Version = 2
				box, err = s.Identity.Keys.Seal(secretBinding(candidate), []byte(password))
				if err != nil {
					return err
				}
				existing, err = q.UpdateIdentityDirectory(ctx, sqlc.UpdateIdentityDirectoryParams{WorkspaceID: ws, ExpectedVersion: 1, Name: candidate.Name, Host: candidate.Host, Url: candidate.Url, AllowedGroupDns: candidate.AllowedGroupDns, BaseDn: candidate.BaseDn, BindDn: candidate.BindDn, BindSecretBox: box, CaPem: candidate.CaPem, SyncIntervalSeconds: 300, MaxStalenessSeconds: 3600, DisabledAt: disabled})
			}
		} else {
			existing, err = q.UpdateIdentityDirectory(ctx, sqlc.UpdateIdentityDirectoryParams{WorkspaceID: ws, ExpectedVersion: existing.Version, Name: candidate.Name, Host: candidate.Host, Url: candidate.Url, AllowedGroupDns: candidate.AllowedGroupDns, BaseDn: candidate.BaseDn, BindDn: candidate.BindDn, BindSecretBox: box, CaPem: candidate.CaPem, SyncIntervalSeconds: 300, MaxStalenessSeconds: 3600, DisabledAt: disabled})
		}
		if err != nil {
			return err
		}
		if err = sso.Invalidate(ctx, q, ws, nil, "directory_changed"); err != nil {
			return err
		}
		if err = sso.Audit(ctx, q, ws, &p.UserID, "directory_changed", &existing.ID); err != nil {
			return err
		}
		out = View(existing)
		return nil
	})
	return out, err
}

// Test checks real TLS, service bind and full query scope without publishing eligibility.
func (s *Service) Test(ctx context.Context, p identitypolicy.Principal, ws uuid.UUID) error {
	var c sqlc.WorkspaceDirectory
	err := s.Identity.DB.Tx(ctx, func(q *sqlc.Queries) error {
		if err := s.authorize(ctx, q, p, ws); err != nil {
			return err
		}
		var err error
		c, err = q.GetWorkspaceIdentityDirectory(ctx, ws)
		return err
	})
	if err != nil {
		return err
	}
	password, err := s.Identity.Keys.Open(secretBinding(c), c.BindSecretBox)
	if err != nil {
		return err
	}
	_, err = s.LDAP.Scan(ctx, c, string(password))
	return err
}

// Members lists only this directory's immutable mappings using bounded cursor pages.
func (s *Service) Members(ctx context.Context, p identitypolicy.Principal, ws uuid.UUID, after *uuid.UUID) (*pb.ListIdentityDirectoryMembersResponse, error) {
	out := &pb.ListIdentityDirectoryMembersResponse{}
	err := s.Identity.DB.Tx(ctx, func(q *sqlc.Queries) error {
		if err := s.authorize(ctx, q, p, ws); err != nil {
			return err
		}
		rows, err := q.ListDirectoryObjects(ctx, sqlc.ListDirectoryObjectsParams{WorkspaceID: ws, AfterID: after, LimitCount: 101})
		if err != nil {
			return err
		}
		statuses := map[string]pb.DirectoryMemberStatus{"active": pb.DirectoryMemberStatus_DIRECTORY_MEMBER_STATUS_ACTIVE, "disabled": pb.DirectoryMemberStatus_DIRECTORY_MEMBER_STATUS_DISABLED, "deleted": pb.DirectoryMemberStatus_DIRECTORY_MEMBER_STATUS_DELETED, "unmapped": pb.DirectoryMemberStatus_DIRECTORY_MEMBER_STATUS_UNMAPPED}
		for i, row := range rows {
			if i == 100 {
				out.NextCursor = rows[99].ID.String()
				break
			}
			user := ""
			if row.UserID != nil {
				user = row.UserID.String()
			}
			out.Members = append(out.Members, &pb.IdentityDirectoryMember{UserId: user, ObjectGuid: row.ObjectGuid.String(), Status: statuses[row.Status], Version: uint64(max(row.Version, 0))})
		}
		return nil
	})
	return out, err
}

// Link binds an explicit objectGUID to an existing member; it assigns no roles or OIDC identity.
func (s *Service) Link(ctx context.Context, p identitypolicy.Principal, ws, user, guid uuid.UUID) error {
	if guid == uuid.Nil || user == uuid.Nil {
		return sso.ErrInvalid
	}
	return s.Identity.DB.Tx(ctx, func(q *sqlc.Queries) error {
		if err := s.authorize(ctx, q, p, ws); err != nil {
			return err
		}
		if _, err := q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: ws, UserID: user}); err != nil {
			return sso.ErrDenied
		}
		c, err := q.GetIdentityDirectoryForUpdate(ctx, ws)
		if err != nil {
			return err
		}
		object, err := q.FindDirectoryObjectGUID(ctx, sqlc.FindDirectoryObjectGUIDParams{WorkspaceID: ws, DirectoryID: c.ID, ObjectGuid: guid})
		if err != nil {
			return sso.ErrNotLinked
		}
		if object.UserID != nil && *object.UserID != user {
			return sso.ErrDenied
		}
		if _, err = q.SetDirectoryObjectUser(ctx, sqlc.SetDirectoryObjectUserParams{WorkspaceID: ws, ID: object.ID, UserID: &user}); err != nil {
			return err
		}
		if object.Status == "unmapped" {
			if _, err = q.SetDirectoryObjectStatus(ctx, sqlc.SetDirectoryObjectStatusParams{WorkspaceID: ws, ID: object.ID, Status: "disabled"}); err != nil {
				return err
			}
		}
		if err = sso.Invalidate(ctx, q, ws, &user, "directory_member_linked"); err != nil {
			return err
		}
		return sso.Audit(ctx, q, ws, &p.UserID, "directory_member_linked", &object.ID)
	})
}

// Sync performs a complete scan and publishes all status transitions in one transaction.
func (s *Service) Sync(ctx context.Context, ws uuid.UUID) error {
	ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	var c sqlc.WorkspaceDirectory
	var run sqlc.DirectorySyncRun
	err := s.Identity.DB.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.LockOAuthWorkspace(ctx, ws); err != nil {
			return err
		}
		if _, err := s.Identity.RequireFeature(ctx, q, ws, identitypolicy.DirectorySync); err != nil {
			return err
		}
		var err error
		c, err = q.GetIdentityDirectoryForUpdate(ctx, ws)
		if err != nil || c.DisabledAt != nil {
			return sso.ErrDenied
		}
		databaseNow, err := q.IdentityDatabaseNow(ctx)
		if err != nil {
			return err
		}
		run, err = q.CreateDirectorySyncRun(ctx, sqlc.CreateDirectorySyncRunParams{WorkspaceID: ws, DirectoryID: c.ID, FullScan: true, ConfigVersion: c.Version, LeaseUntil: databaseNow.Add(120 * time.Second), Status: "running", StartedAt: databaseNow, Generation: c.Generation + 1})
		return err
	})
	if err != nil {
		return err
	}
	password, err := s.Identity.Keys.Open(secretBinding(c), c.BindSecretBox)
	var objects []Object
	if err == nil {
		objects, err = s.LDAP.Scan(ctx, c, string(password))
	}
	if err == nil {
		err = s.publish(ctx, c, run, objects)
	}
	if err != nil {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = s.Identity.DB.Tx(cleanup, func(q *sqlc.Queries) error {
			if _, e := q.FinishDirectorySyncRun(cleanup, sqlc.FinishDirectorySyncRunParams{ID: run.ID, Status: "failed"}); e != nil {
				return e
			}
			return q.SetDirectoryError(cleanup, sqlc.SetDirectoryErrorParams{WorkspaceID: ws, ID: c.ID, LastError: "Directory synchronization unavailable"})
		})
	}
	return err
}

func (s *Service) publish(ctx context.Context, c sqlc.WorkspaceDirectory, run sqlc.DirectorySyncRun, objects []Object) error {
	if len(objects) > 100000 {
		return ErrDirectory
	}
	snapshot := map[uuid.UUID]Object{}
	for _, o := range objects {
		if o.GUID == uuid.Nil || snapshot[o.GUID].GUID != uuid.Nil {
			return ErrDirectory
		}
		snapshot[o.GUID] = o
	}
	return s.Identity.DB.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.LockOAuthWorkspace(ctx, c.WorkspaceID); err != nil {
			return err
		}
		if _, err := s.Identity.RequireFeature(ctx, q, c.WorkspaceID, identitypolicy.DirectorySync); err != nil {
			return err
		}
		current, err := q.GetIdentityDirectoryForUpdate(ctx, c.WorkspaceID)
		if err != nil || current.Version != c.Version || current.Generation != c.Generation || current.DisabledAt != nil || !s.now().Before(run.LeaseUntil) {
			return sso.ErrChanged
		}
		for _, o := range objects {
			if _, err = q.CreateDirectorySyncObject(ctx, sqlc.CreateDirectorySyncObjectParams{WorkspaceID: c.WorkspaceID, DirectoryID: c.ID, RunID: run.ID, ObjectGuid: o.GUID, DistinguishedName: o.DN, Eligible: o.Eligible, Disabled: o.Disabled}); err != nil {
				return err
			}
		}
		var after *uuid.UUID
		seen := map[uuid.UUID]bool{}
		for {
			rows, err := q.ListDirectoryObjects(ctx, sqlc.ListDirectoryObjectsParams{WorkspaceID: c.WorkspaceID, AfterID: after, LimitCount: 500})
			if err != nil {
				return err
			}
			if len(rows) == 0 {
				break
			}
			for _, existing := range rows {
				if existing.DirectoryID != c.ID {
					return sso.ErrChanged
				}
				o, present := snapshot[existing.ObjectGuid]
				status := existing.Status
				missing := existing.MissingFullScans
				dn := existing.DistinguishedName
				last := existing.LastSeenRunID
				if present {
					seen[o.GUID] = true
					missing = 0
					dn = o.DN
					last = &run.ID
					status = "active"
					if o.Disabled || !o.Eligible {
						status = "disabled"
					}
					if existing.UserID == nil && status == "active" {
						status = "unmapped"
					}
				} else {
					// Authoritative absence closes access on the first complete scan.
					// A second scan only finalizes the durable deletion tombstone.
					status = "disabled"
					if missing < 2 {
						missing++
					}
					if missing >= 2 {
						status = "deleted"
					}
				}
				if _, err = q.UpdateDirectoryObjectSnapshot(ctx, sqlc.UpdateDirectoryObjectSnapshotParams{WorkspaceID: c.WorkspaceID, DirectoryID: c.ID, ID: existing.ID, ExpectedVersion: existing.Version, DistinguishedName: dn, Status: status, LastSeenRunID: last, MissingFullScans: missing}); err != nil {
					return err
				}
				if status != existing.Status && existing.UserID != nil {
					if err = sso.Invalidate(ctx, q, c.WorkspaceID, existing.UserID, "directory_status_changed"); err != nil {
						return err
					}
					if err = sso.Audit(ctx, q, c.WorkspaceID, nil, "directory_status_changed", &existing.ID); err != nil {
						return err
					}
				}
			}
			id := rows[len(rows)-1].ID
			after = &id
		}
		for _, o := range objects {
			if !seen[o.GUID] {
				status := "unmapped"
				if o.Disabled || !o.Eligible {
					status = "disabled"
				}
				if _, err = q.CreateDirectoryObject(ctx, sqlc.CreateDirectoryObjectParams{WorkspaceID: c.WorkspaceID, DirectoryID: c.ID, ObjectGuid: o.GUID, DistinguishedName: o.DN, Status: status}); err != nil {
					return err
				}
			}
		}
		if _, err = q.FinishDirectorySyncRun(ctx, sqlc.FinishDirectorySyncRunParams{ID: run.ID, Status: "succeeded", Complete: true, ObjectsSeen: int32(len(objects))}); err != nil { //nolint:gosec // G115: publish rejects snapshots above 100000 objects before this bounded conversion.
			return err
		}
		_, err = q.PublishDirectorySuccess(ctx, sqlc.PublishDirectorySuccessParams{WorkspaceID: c.WorkspaceID, DirectoryID: c.ID, ConfigVersion: c.Version, Generation: run.Generation, RunID: run.ID})
		return err
	})
}

// Run schedules due directories fairly using four bounded scan workers. Listing failures
// are retried while durable freshness checks continue to fail closed independently.
func (s *Service) Run(ctx context.Context) error { return s.run(ctx, time.Second) }

func (s *Service) run(ctx context.Context, interval time.Duration) error {
	jobs := make(chan uuid.UUID, 4)
	var workers sync.WaitGroup
	var mu sync.Mutex
	active := map[uuid.UUID]bool{}
	nextAttempt := map[uuid.UUID]time.Time{}
	for range 4 {
		workers.Go(func() {
			for {
				select {
				case <-ctx.Done():
					return
				case ws := <-jobs:
					err := s.Sync(ctx, ws)
					mu.Lock()
					delete(active, ws)
					mu.Unlock()
					if err != nil && ctx.Err() == nil && s.OnError != nil {
						s.OnError(ErrDirectory)
					}
				}
			}
		})
	}
	defer workers.Wait()
	timer := time.NewTicker(interval)
	defer timer.Stop()
	var after *uuid.UUID
	schedule := func() {
		for {
			listingCtx, stopListing := context.WithTimeout(ctx, 3*time.Second)
			rows, err := s.Identity.DB.Q.ListEnabledIdentityDirectoriesAfter(listingCtx, sqlc.ListEnabledIdentityDirectoriesAfterParams{AfterID: after, LimitCount: 100})
			stopListing()
			if err != nil {
				if s.OnError != nil {
					s.OnError(ErrDirectory)
				}
				return
			}
			if len(rows) == 0 {
				after = nil
				return
			}
			for _, c := range rows {
				if c.LastSuccessAt == nil || !s.now().Before(c.LastSuccessAt.Add(time.Duration(c.SyncIntervalSeconds)*time.Second)) {
					mu.Lock()
					busy := active[c.WorkspaceID] || s.now().Before(nextAttempt[c.WorkspaceID])
					if !busy {
						active[c.WorkspaceID] = true
						nextAttempt[c.WorkspaceID] = s.now().Add(5 * time.Minute)
					}
					mu.Unlock()
					if !busy {
						select {
						case jobs <- c.WorkspaceID:
						case <-ctx.Done():
							mu.Lock()
							delete(active, c.WorkspaceID)
							delete(nextAttempt, c.WorkspaceID)
							mu.Unlock()
							return
						default:
							mu.Lock()
							delete(active, c.WorkspaceID)
							delete(nextAttempt, c.WorkspaceID)
							mu.Unlock()
							return
						}
					}
				}
				id := c.ID
				after = &id
			}
			if len(rows) < 100 {
				after = nil
				return
			}
		}
	}
	schedule()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			schedule()
		}
	}
}
