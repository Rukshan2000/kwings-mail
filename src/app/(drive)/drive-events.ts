export const DRIVE_UPLOAD_EVENT = "kwings-mail:drive-upload";
export const DRIVE_NEW_FOLDER_EVENT = "kwings-mail:drive-new-folder";
/** Detail: `DriveStorageDetail`. Sent by the page whenever a listing loads. */
export const DRIVE_STORAGE_EVENT = "kwings-mail:drive-storage";
/** Sent after a listing loads so the sidebar can refresh its folder list. */
export const DRIVE_FOLDERS_EVENT = "kwings-mail:drive-folders";

/** Asks the open listing to reload, e.g. after the sidebar created a folder. */
export const DRIVE_REFRESH_EVENT = "kwings-mail:drive-refresh";

export type DriveStorageDetail = { used: number; limit: number | null };
