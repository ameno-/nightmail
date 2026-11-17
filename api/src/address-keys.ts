import { sql } from 'drizzle-orm';
import { ApiError, digest, id, isoTime, randomSecret, type Actor, type Ctx, type DbExecutor } from './core.js';
import { mailboxKeys, type MailboxPermission } from './db/mailbox.js';
import { recordAudit } from './audit.js';
import { approvalMadeKey, inactiveKey } from './auth.js';
import { holdReceiving, ownReceiving } from './rituals.js';
import { secretPrefixes, shownPrefix } from './brand.js';

// An API key limited to receiving addresses or to one agent inbox. These keep their own table and bearer prefix
// (nm_mbx_…): only mailboxAuth accepts them, so they never reach a workspace route. The public API lists, creates and
// revokes them as API keys (auth.ts), with the access below in place of workspace permissions.
export type LimitedAccess =
  | { type: 'addresses'; addressIds?: string[] | null; mail: MailboxPermission[] }
  | { type: 'inbox'; inboxId: string; mail: MailboxPermission[] };
type Row = typeof mailboxKeys.$inferSelect;

/** What a limited key may do, as the API shows it. A key on exactly one agent inbox belongs to it (inbox_id). */
export const limitedAccess = (row: Pick<Row, 'inboxId' | 'mailboxIds' | 'permissions'>) => ({
  type: row.inboxId ? 'inbox' as const : 'addresses' as const, addressIds: row.mailboxIds, inboxId: row.inboxId ?? null, mail: row.permissions,
});
export const limitedKeyView = (row: Row) => ({
  id: row.id, name: row.name, prefix: row.prefix, permissions: [] as ('read' | 'send' | 'manage')[], domains: [] as string[],
  access: limitedAccess(row), expiresAt: isoTime(row.expiresAt),
  createdAt: isoTime(row.createdAt)!, lastUsedAt: isoTime(row.lastUsedAt), revokedAt: isoTime(row.revokedAt),
});

/**
 * Creates a limited key; the secret is returned once. The caller has already checked that it may administer keys
 * (an unrestricted manage credential, never an agent token). A key an MCP approval creates is tied to it (ownReceiving)
 * and needs its receiving consent. `field` names the request field for errors: the API's access object, or the
 * deprecated createInboundKey's top-level fields.
 */
export async function createLimitedKey(c: Ctx, workspaceId: string, name: string, access: LimitedAccess, field: { addresses: string; inbox: string; mail: string }) {
  const mail = [...new Set(access.mail)];
  let mailboxIds: string[] | null, inboxId: string | null = null;
  if (access.type === 'inbox') {
    if (mail.includes('create')) throw new ApiError(422, 'VALIDATION_FAILED', 'A key for one inbox can read, send and modify; create needs a key for addresses.', field.mail);
    mailboxIds = [access.inboxId]; inboxId = access.inboxId;
  } else {
    mailboxIds = access.addressIds ? [...new Set(access.addressIds)] : null;
    if (mail.includes('create') && mailboxIds === null || mailboxIds?.length === 0 && !mail.includes('create'))
      throw new ApiError(422, 'ADDRESS_SCOPE_REQUIRED', 'Provisioning keys need an explicit addressIds scope.', field.addresses);
  }
  const secret = randomSecret(secretPrefixes.addressKey);
  const row = await c.env.db.transaction(async tx => {
    let expiresAt: string | null = null;
    if (mailboxIds?.length) {
      // Held until commit, so an inbox can't be deleted between this check and the insert (inbox_end locks the row).
      const found = (await tx.execute<{ id: string; kind: string; delete_after: string | null; active: boolean }>(sql`SELECT id, kind, delete_after::text, delete_after IS NULL OR delete_after > now() AS active
        FROM mailboxes WHERE workspace_id = ${workspaceId} AND id = ANY(${sql.param(mailboxIds)}::text[]) FOR SHARE`)).rows;
      if (access.type === 'inbox') {
        if (found[0]?.kind !== 'inbox' || !found[0].active) throw new ApiError(422, 'UNKNOWN_INBOX', 'Choose an active agent inbox in this workspace.', field.inbox);
        // It ends with the inbox (inbox_end), and with an expiring inbox's lease.
        expiresAt = found[0].delete_after;
      } else if (found.length !== mailboxIds.length) throw new ApiError(422, 'MAILBOX_NOT_FOUND', 'Every ID must identify an existing receiving address.', field.addresses);
    }
    const [created] = await tx.insert(mailboxKeys).values({ id: id('mbk'), workspaceId, name, hash: await digest(secret), prefix: shownPrefix(secret), mailboxIds, inboxId, permissions: mail, expiresAt }).returning();
    await ownReceiving(tx, c, 'key', created!.id);
    await recordAudit(tx, c, { action: 'api_key.create', workspaceId, target: { type: 'api_key', id: created!.id },
      after: { name, access: limitedAccess(created!), mcpGrant: c.get('actor')?.grantId } });
    return created!;
  });
  c.header('Cache-Control', 'no-store');
  return { row, secret };
}

export type LimitedChange = { name?: string; access?: { addressIds?: string[] | null; addAddressIds?: string[]; removeAddressIds?: string[]; mail?: MailboxPermission[] }; permissions?: unknown; domains?: unknown };
/**
 * updateApiKey for a limited key: its name, its addresses and its mail, in place, under the rules createLimitedKey
 * applies to a new key, so a change never gives a key what a new one couldn't have. The caller has checked it may
 * administer keys and isn't this key. The change applies at once: every request with the key reads its row
 * (authorizeInboxKey), a long poll reads it again each second (auth.ts longPoll), and dispatch checks the sending
 * address against it (dispatcher.ts), so mail queued from a removed address is not sent.
 */
export async function updateLimitedKey(tx: DbExecutor, c: Ctx, a: Actor, keyId: string, change: LimitedChange) {
  if (change.permissions || change.domains) throw new ApiError(422, 'VALIDATION_FAILED', 'A key for addresses or an inbox takes its permissions in access.mail and has no sender domains.', change.permissions ? 'permissions' : 'domains');
  const access = change.access ?? {}, add = access.addAddressIds ?? [], remove = access.removeAddressIds ?? [];
  if (access.addressIds !== undefined && (add.length || remove.length)) throw new ApiError(422, 'VALIDATION_FAILED', 'Replace the addresses with addressIds, or add and remove some; not both.', 'access.addressIds');
  if (add.some(id => remove.includes(id))) throw new ApiError(422, 'VALIDATION_FAILED', 'An address can\'t be both added and removed.', 'access.removeAddressIds');
  // An approval (or a key it made) changes a limited key as it creates one: with receiving consent, holding the approval
  // until commit, before the key row (the order its removal takes them in).
  await holdReceiving(tx, c);
  const [row] = await tx.select().from(mailboxKeys).where(sql`${mailboxKeys.workspaceId} = ${a.workspaceId} AND ${mailboxKeys.id} = ${keyId}`).for('update');
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'API key was not found.');
  if (row.revokedAt || row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) throw inactiveKey();
  await approvalMadeKey(tx, a, 'key', row.id);
  const inbox = row.inboxId !== null, mail = access.mail ? [...new Set(access.mail)] : row.permissions;
  if (inbox && (access.addressIds !== undefined || add.length || remove.length)) throw new ApiError(422, 'VALIDATION_FAILED', 'A key for one inbox keeps its inbox. Change its mail, or create a key for addresses.', 'access.addressIds');
  if (inbox && mail.includes('create')) throw new ApiError(422, 'VALIDATION_FAILED', 'A key for one inbox can read, send and modify; create needs a key for addresses.', 'access.mail');
  let ids = row.mailboxIds;
  if (access.addressIds !== undefined) ids = access.addressIds && [...new Set(access.addressIds)];
  else if (ids === null && remove.length) throw new ApiError(422, 'ADDRESS_SCOPE_REQUIRED', 'This key covers every address. Set addressIds to the ones it keeps.', 'access.removeAddressIds');
  // A key for every address already has the ones added.
  else if (ids !== null) ids = [...new Set([...ids, ...add])].filter(id => !remove.includes(id));
  if (ids && ids.length > 500) throw new ApiError(422, 'VALIDATION_FAILED', 'A key covers at most 500 addresses. Use a key for every address instead.', access.addressIds ? 'access.addressIds' : 'access.addAddressIds');
  if (!inbox && (mail.includes('create') && ids === null || ids?.length === 0 && !mail.includes('create')))
    throw new ApiError(422, 'ADDRESS_SCOPE_REQUIRED', 'Provisioning keys need an explicit addressIds scope.', 'access.addressIds');
  // Every address it gains is one of this workspace's, held until commit like createLimitedKey's.
  const gained = ids?.filter(id => !row.mailboxIds?.includes(id)) ?? [];
  if (gained.length) {
    const found = (await tx.execute<{ id: string }>(sql`SELECT id FROM mailboxes WHERE workspace_id = ${a.workspaceId} AND id = ANY(${sql.param(gained)}::text[]) FOR SHARE`)).rows;
    if (found.length !== gained.length) throw new ApiError(422, 'MAILBOX_NOT_FOUND', 'Every ID must identify an existing receiving address.', access.addressIds ? 'access.addressIds' : 'access.addAddressIds');
  }
  const name = change.name ?? row.name;
  if (name === row.name && JSON.stringify(ids) === JSON.stringify(row.mailboxIds) && JSON.stringify(mail) === JSON.stringify(row.permissions)) return row;
  const [updated] = await tx.update(mailboxKeys).set({ name, mailboxIds: ids, permissions: mail }).where(sql`${mailboxKeys.id} = ${row.id}`).returning();
  // Before and after are cut to 20 addresses in the trail; what changed is listed on its own.
  const removed = ids === null ? [] : row.mailboxIds?.filter(id => !ids.includes(id)) ?? [];
  await recordAudit(tx, c, { action: 'api_key.update', workspaceId: a.workspaceId, target: { type: 'api_key', id: row.id },
    before: { name: row.name, access: limitedAccess(row) }, after: { name, access: limitedAccess(updated!) },
    details: { ...gained.length && row.mailboxIds ? { addedAddressIds: gained } : {}, ...removed.length ? { removedAddressIds: removed } : {} } });
  return updated!;
}

/** Revokes a limited key. A repeated revoke keeps the first time and writes no second audit row. */
export async function revokeLimitedKey(c: Ctx, workspaceId: string, keyId: string) {
  return await c.env.db.transaction(async tx => {
    const [row] = await tx.select().from(mailboxKeys).where(sql`${mailboxKeys.workspaceId} = ${workspaceId} AND ${mailboxKeys.id} = ${keyId}`).for('update');
    if (!row) return null;
    if (row.revokedAt) return { row, fresh: false };
    const [revoked] = await tx.update(mailboxKeys).set({ revokedAt: new Date().toISOString() }).where(sql`${mailboxKeys.id} = ${row.id}`).returning();
    await recordAudit(tx, c, { action: 'api_key.revoke', workspaceId, target: { type: 'api_key', id: row.id }, before: { name: row.name, access: limitedAccess(row) } });
    return { row: revoked!, fresh: true };
  });
}
