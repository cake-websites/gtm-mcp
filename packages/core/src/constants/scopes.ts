// Cake fork: read-only. Tokens minted by this server can never write to GTM.
export const GTM_API_SCOPES = [
  "https://www.googleapis.com/auth/tagmanager.readonly",
];

// Cake fork: edit mode adds workspace edits only - no publish, delete, or user management.
export const GTM_EDIT_SCOPES = [
  ...GTM_API_SCOPES,
  "https://www.googleapis.com/auth/tagmanager.edit.containers",
];

export const GTM_OAUTH_SCOPES = ["email", "profile", ...GTM_API_SCOPES];

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const GOOGLE_AUTHORIZE_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";
