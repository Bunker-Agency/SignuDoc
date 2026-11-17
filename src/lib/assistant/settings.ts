import { type DbPool, getDb, withTransaction } from "../db/connection.ts";
import { recordSystemAuditEvent } from "../services/system-audit.ts";
import { type Actor, lockActor } from "../sign-in-security.ts";
import { endAllAssistantConnections } from "./connections.ts";

/**
 * Turns the install's AI assistant connections on or off. Turning them off
 * ends every connection in the same transaction.
 */
export async function setAssistantConnections(
  actor: Actor,
  enabled: boolean,
  database: DbPool = getDb(),
): Promise<void> {
  const { readStoredSettings, saveSettings } = await import("../settings.ts");

  await withTransaction(async (tx) => {
    await lockActor(actor, tx);
    await tx.query(`SELECT id FROM app_settings WHERE id FOR UPDATE`);

    const current = await readStoredSettings(tx);
    const was = current?.assistantConnections ?? false;

    if (was === enabled) {
      return;
    }

    await saveSettings({ assistantConnections: enabled }, tx);

    if (!enabled) {
      await endAllAssistantConnections(tx);
    }

    await recordSystemAuditEvent(
      {
        actorEmail: actor.email,
        actorUserId: actor.userId,
        event: "settings_changed",
        ipAddress: actor.ipAddress ?? null,
        metadata: {
          changes: { assistantConnections: { from: was, to: enabled } },
        },
        userAgent: actor.userAgent ?? null,
      },
      tx,
    );
  }, database);
}
