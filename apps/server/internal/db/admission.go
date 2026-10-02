package db

import (
	"context"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/jackc/pgx/v5"
)

// Admission runs before a classified request's database write, in that write's
// transaction. The returned release function runs after commit or rollback. It
// must use the supplied queries and must not perform network I/O or start a TX.
// Database infrastructure deliberately has no dependency on authorization.
type Admission func(context.Context, *sqlc.Queries) (release func(), err error)

type admissionKey struct{}

// WithAdmission opts a classified request into commit authorization. Background
// jobs, migration connections and ordinary reads do not inherit it implicitly.
func WithAdmission(ctx context.Context, check Admission) context.Context {
	return context.WithValue(ctx, admissionKey{}, check)
}

// WithoutAdmission removes the request write boundary for independent cleanup.
// Access-granting jobs must instead carry their own persisted authorization.
func WithoutAdmission(ctx context.Context) context.Context {
	return context.WithValue(ctx, admissionKey{}, Admission(nil))
}

// TxRaw is the same guarded boundary as Tx, also exposing the transaction for
// existing dynamic queries. No transaction remains open after fn returns.
func (d *DB) TxRaw(ctx context.Context, fn func(*sqlc.Queries, pgx.Tx) error) error {
	var release func()
	defer func() {
		if release != nil {
			release()
		}
	}()
	return pgx.BeginFunc(ctx, d.Pool, func(tx pgx.Tx) error {
		q := d.Q.WithTx(tx)
		if check, ok := ctx.Value(admissionKey{}).(Admission); ok && check != nil {
			var err error
			release, err = check(ctx, q)
			if err != nil {
				return err
			}
		}
		return fn(q, tx)
	})
}

// GuardValue gives a direct generated mutation the same boundary as a multi-
// statement Tx. Its callback is a database operation, never a whole handler.
func GuardValue[T any](ctx context.Context, d *DB, fn func(*sqlc.Queries) (T, error)) (T, error) {
	var result T
	if check, _ := ctx.Value(admissionKey{}).(Admission); check == nil {
		return fn(d.Q)
	}
	err := d.Tx(ctx, func(q *sqlc.Queries) error {
		var err error
		result, err = fn(q)
		return err
	})
	return result, err
}

// GuardExec is GuardValue for generated mutations without a result.
func GuardExec(ctx context.Context, d *DB, fn func(*sqlc.Queries) error) error {
	_, err := GuardValue(ctx, d, func(q *sqlc.Queries) (struct{}, error) {
		return struct{}{}, fn(q)
	})
	return err
}
