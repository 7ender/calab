import { RoomType, type RoomInvite } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Link2Off } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { Button, Card, IconButton, Row, Select, Spinner, Toggle } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { fmt } from '../../lib/format';
import { api } from '../../lib/api/endpoints';
import { roomInviteUrl } from '../../services/links';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { roomLinkError } from './roomLink';

const EXPIRY: Array<{ s: number; key: MessageKey }> = [
  { s: 3600, key: 'people.link.hour' },
  { s: 86400, key: 'people.link.day' },
  { s: 7 * 86400, key: 'people.link.week' },
  { s: 0, key: 'people.link.never' },
];
export const MAX_USES = [0, 1, 5, 10, 25, 50, 100];

/** Always https (docs/09 #53); '' only without a known server (nothing to copy then). */
export const linkOf = (i: Pick<RoomInvite, 'code'>): string => roomInviteUrl(useSession.getState().serverUrl, i.code) ?? '';

async function copy(i: RoomInvite, created = false): Promise<void> {
  try {
    const link = linkOf(i);
    if (!link) throw new Error('no server URL for the room link');
    await navigator.clipboard.writeText(link);
    toast.success(created ? `${t('people.link.created')} · ${t('people.link.copied').toLowerCase()}` : t('people.link.copied'));
  } catch {
    if (created) toast.success(t('people.link.created'));
  }
}

/** One line about a link: expiry · uses · what guests may do. */
export function linkSummary(i: RoomInvite, voice: boolean): string {
  const rights = [
    voice && i.allowSpeak ? t('people.link.speak') : '',
    i.allowMessages ? t('people.link.messages') : '',
    i.allowFiles ? t('people.link.files') : '',
    voice && i.allowStream ? t('people.link.stream') : '',
  ]
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  return [
    i.expiresAt ? t('people.link.until', { date: fmt.dateTime(timestampDate(i.expiresAt), 'short') }) : t('people.link.forever'),
    i.maxUses ? t('people.link.uses', { uses: i.uses, max: i.maxUses }) : t('people.link.usesUnlimited', { uses: i.uses }),
    i.allowGuests ? '' : t('people.link.guestsOff'),
    rights.join(', '),
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Room settings → «Ссылка для гостей» (docs/09 #35, ADR-0016): create a link (expiry, max
 * uses, guest rights), copy it, revoke, list active ones. Needs MANAGE_ROOM (server-checked).
 */
export function RoomLinkTab({ roomId }: { roomId: string }): ReactNode {
  const voice = useRooms((s) => s.byId[roomId]?.type === RoomType.VOICE);
  const qc = useQueryClient();
  const key = ['roomInvites', roomId];
  const q = useQuery({ queryKey: key, queryFn: () => api.roomInvites.list(roomId) });
  const [expires, setExpires] = useState(7 * 86400);
  const [maxUses, setMaxUses] = useState(0);
  const [guests, setGuests] = useState(true);
  const [speak, setSpeak] = useState(true);
  const [messages, setMessages] = useState(true);
  const [files, setFiles] = useState(false);
  const [stream, setStream] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      api.roomInvites.create(roomId, {
        expiresInSeconds: expires,
        maxUses,
        allowGuests: guests,
        allowSpeak: voice && speak,
        allowMessages: messages,
        allowFiles: files,
        allowStream: voice && stream,
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: key });
      if (r.invite) void copy(r.invite, true);
    },
    onError: (e) => toast.error(roomLinkError(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.roomInvites.revoke(roomId, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toast.error(roomLinkError(e)),
  });

  const invites = q.data?.invites ?? [];
  return (
    <>
      <Card title={t('people.link.new')} footer={t('people.link.newHint')}>
        <Row label={t('people.link.expiry')}>
          <Select aria-label={t('people.link.expiry')} className="w-60" value={expires} onChange={(e) => setExpires(Number(e.target.value))}>
            {EXPIRY.map((x) => (
              <option key={x.s} value={x.s}>
                {t(x.key)}
              </option>
            ))}
          </Select>
        </Row>
        <Row label={t('people.link.maxUses')}>
          <Select aria-label={t('people.link.maxUses')} className="w-60" value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
            {MAX_USES.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? t('people.link.unlimited') : n}
              </option>
            ))}
          </Select>
        </Row>
        <Row label={t('people.link.allowGuests')} hint={t('people.link.allowGuestsHint')}>
          <Toggle label={t('people.link.allowGuests')} checked={guests} onChange={setGuests} />
        </Row>
      </Card>
      <Card title={t('people.link.rights')}>
        {voice ? (
          <Row label={t('people.link.speak')}>
            <Toggle label={t('people.link.speak')} checked={speak} onChange={setSpeak} />
          </Row>
        ) : null}
        <Row label={t('people.link.messages')}>
          <Toggle label={t('people.link.messages')} checked={messages} onChange={setMessages} />
        </Row>
        <Row label={t('people.link.files')}>
          <Toggle label={t('people.link.files')} checked={files} onChange={setFiles} />
        </Row>
        {voice ? (
          <Row label={t('people.link.stream')}>
            <Toggle label={t('people.link.stream')} checked={stream} onChange={setStream} />
          </Row>
        ) : null}
      </Card>
      <div className="-mt-3 flex justify-end">
        <Button busy={create.isPending} onClick={() => create.mutate()}>
          {t('people.link.create')}
        </Button>
      </div>
      <Card title={t('people.link.active')}>
        {q.isLoading ? (
          <div className="grid min-h-10 place-items-center">
            <Spinner className="size-4" />
          </div>
        ) : invites.length === 0 ? (
          <p className="flex min-h-10 items-center px-3 text-body text-muted">{t('people.link.none')}</p>
        ) : (
          invites.map((i) => (
            <div key={i.id} className="flex min-h-12 items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <code className="selectable block truncate font-mono text-caption" title={linkOf(i)}>
                  {linkOf(i)}
                </code>
                <div className="truncate text-caption text-muted" title={linkSummary(i, voice)}>
                  {linkSummary(i, voice)}
                </div>
              </div>
              <IconButton label={t('people.link.copyAria', { code: i.code })} onClick={() => void copy(i)}>
                <Copy className="size-4" />
              </IconButton>
              <IconButton
                label={t('people.link.revokeAria', { code: i.code })}
                danger
                onClick={() =>
                  void confirmAction(t('people.link.revoke'), t('people.link.revokeConfirm'), t('people.link.revoke')).then((ok) => ok && revoke.mutate(i.id))
                }
              >
                <Link2Off className="size-4" />
              </IconButton>
            </div>
          ))
        )}
      </Card>
    </>
  );
}
