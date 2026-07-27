import type { ReviewJobMessage } from '@shared/schema';
import { authSessionUserSchema, type AuthSessionUser } from '@shared/api';

export interface WorkersAiBinding {
  run(model: string, input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<any>;
}

export interface QueueProducer<T> {
  send(message: T, options?: { delaySeconds?: number }): Promise<void>;
}

export interface AssetsBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface HyperdriveBinding {
  connectionString: string;
}

// D-26: re-export of the SINGLE canonical schema defined in @shared/api — NOT a second
// Zod definition. The server and client sides share one schema object via two import
// paths, eliminating the client/server schema drift risk (06-REVIEWS.md HIGH finding).
export const dashboardSessionUserSchema = authSessionUserSchema;
export type DashboardSessionUser = AuthSessionUser;

export interface AppBindings {
  AI: WorkersAiBinding;
  APP_KV: KVNamespace;
  REVIEW_QUEUE: QueueProducer<ReviewJobMessage>;
  REVIEW_WORKFLOW: Workflow;
  // Phase 29 / QA-IDX-01 (D-06): the SEPARATE codebase-index build Workflow, deliberately not a new
  // payload kind inside REVIEW_WORKFLOW (Phase 20.1 spent eight plans hardening that dispatch; an
  // unrelated `index` branch is exactly the routing hole those BLOCKERs documented).
  // Declared OPTIONAL in plan 29-01 on purpose: the wrangler.jsonc binding, the IndexWorkflow class
  // and the cf-typegen regeneration land in plan 29-05, so until then the binding genuinely is absent
  // at runtime and a required property would be a type-level lie. 29-05 makes it required.
  INDEX_WORKFLOW?: Workflow;
  ASSETS: AssetsBinding;
  HYPERDRIVE: HyperdriveBinding;
  APP_PRIVATE_KEY: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_WEBHOOK_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  AUTH_CALLBACK_URL: string;
  APP_URL: string;
  DASHBOARD_ALLOWED_USERS: string;
  LLM_CONFIG_ENCRYPTION_KEY: string;
  BITBUCKET_CLIENT_ID: string;
  BITBUCKET_CLIENT_SECRET: string;
  BITBUCKET_AUTH_CALLBACK_URL: string;
  BOT_USERNAME: string;
  ENVIRONMENT: string;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
}

export interface AppVariables {
  sessionToken: string | null;
  sessionUser: DashboardSessionUser | null;
  requestId: string;
}

export type AppEnv = {
  Bindings: AppBindings;
  Variables: AppVariables;
};
