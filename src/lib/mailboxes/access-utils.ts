import type { AppDatabase } from "@/db";

// Kwings: shared mailboxes are enabled without a Team license; access still needs a mailbox_access grant.
export async function isTeamMailboxSharingEnabled(_db: AppDatabase): Promise<boolean> {
	return true;
}
