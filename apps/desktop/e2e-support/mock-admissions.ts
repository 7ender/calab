/**
 * Guest admission in the mock (ADR-0040): the stored knocks and their pure rules. The routes,
 * the link join and the gateway fan-out live in mock-server.ts (`admissionRoutes`, `knock`,
 * `decideAdmission`).
 *
 * Simplifications against the server: no sweeper (tests call `decideAdmission(…, 'no_answer')`
 * for «Никто не ответил»), a declined knock is dropped at once (no 10-minute hold), link uses are
 * not refunded, the 50-knock cap is not enforced.
 */
import { create } from '@bufbuild/protobuf';
import type { Timestamp } from '@bufbuild/protobuf/wkt';
import { RoomAdmissionSchema, RoomAdmissionStatus, UserSchema, type RoomAdmission, type User } from '@calaba/protocol';

/** A knock that is waiting (declined / admitted ones are removed from the state). */
export interface AdmissionRec {
  roomId: string;
  workspaceId: string;
  userId: string;
  inviteId: string;
  /** The link's author: decides too. */
  inviteCreatedBy: string;
  requestedAt: Timestamp;
}

export const admissionKey = (roomId: string, userId: string): string => `${roomId}:${userId}`;

/** The link's own setting, else the room's (unset inherits). */
export function requiresApproval(roomGuestApproval: boolean, linkRequireApproval: boolean | undefined): boolean {
  return linkRequireApproval ?? roomGuestApproval;
}

export interface AdmissionOutcome {
  status: RoomAdmissionStatus;
  decidedBy?: string;
  decidedAt?: Timestamp;
  noAnswer?: boolean;
}

/** The outcome of a decision: `no_answer` = the server's 30-minute sweep, `cancelled` = the guest withdrew. */
export function admissionOutcome(status: 'admitted' | 'declined' | 'no_answer' | 'cancelled', by: string, at: Timestamp): AdmissionOutcome {
  switch (status) {
    case 'admitted':
      return { status: RoomAdmissionStatus.ADMITTED, decidedBy: by, decidedAt: at };
    case 'declined':
      return { status: RoomAdmissionStatus.DECLINED, decidedBy: by, decidedAt: at };
    case 'no_answer':
      return { status: RoomAdmissionStatus.DECLINED, decidedAt: at, noAnswer: true };
    default:
      return { status: RoomAdmissionStatus.CANCELLED };
  }
}

/** The deciders' view: the knocking user in full, the link's author. */
export function deciderView(a: AdmissionRec, user: User | undefined, outcome?: AdmissionOutcome): RoomAdmission {
  return create(RoomAdmissionSchema, {
    roomId: a.roomId,
    workspaceId: a.workspaceId,
    user: user ?? create(UserSchema, { id: a.userId }),
    inviteId: a.inviteId,
    inviteCreatedBy: a.inviteCreatedBy,
    status: outcome?.status ?? RoomAdmissionStatus.PENDING,
    requestedAt: a.requestedAt,
    decidedBy: outcome?.decidedBy ?? '',
    noAnswer: outcome?.noAnswer ?? false,
    ...(outcome?.decidedAt ? { decidedAt: outcome.decidedAt } : {}),
  });
}

/** The guest's own view: the user by id, the names for the waiting screen. */
export function guestView(a: AdmissionRec, roomName: string, workspaceName: string, outcome?: AdmissionOutcome): RoomAdmission {
  return create(RoomAdmissionSchema, {
    roomId: a.roomId,
    workspaceId: a.workspaceId,
    user: create(UserSchema, { id: a.userId }),
    inviteId: a.inviteId,
    status: outcome?.status ?? RoomAdmissionStatus.PENDING,
    requestedAt: a.requestedAt,
    decidedBy: outcome?.decidedBy ?? '',
    noAnswer: outcome?.noAnswer ?? false,
    ...(outcome?.decidedAt ? { decidedAt: outcome.decidedAt } : {}),
    roomName,
    workspaceName,
  });
}
