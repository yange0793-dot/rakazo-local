import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type {
  AgentContextStrategy,
  AgentRuntime,
  BillingProvider,
  ConnectorProvider,
  JobPublisher,
  ManagedConnectorProvider,
  MessagingSurface,
  NotificationProvider,
  RealtimeFanout,
  SandboxProvider,
  TransactionalEmailProvider,
} from "@rakazo/adapter-kit";
import { EmailRecipientRejectedError } from "@rakazo/adapter-kit";
import type {
  ComposioProvider,
  ConnectorRegistry,
  createRunExecutor,
  PluginRepoFetcher,
  PluginTextReader,
  RemoteConnectorDependencies,
  RunRuntimeEnv,
  UserDeviceGateway,
} from "@rakazo/adapters";
import {
  ChatSdkMessagingSurface,
  CodexCatalogCache,
  contentKeyProviderFromEnv,
  createAgentHomeStore,
  createAgentRuntimeSelection,
  createApnsActivityProvider,
  createApnsVoipProvider,
  createArtifactStore,
  createCloudAgentConnection,
  createConnectorRuntime,
  createManagedMemoryProvider,
  createMediaGenerationProvider,
  createPaymentWalletProvider,
  createProductAnalytics,
  createRunReconciler,
  createRunRuntime,
  createRunSandbox,
  createRunSecretWriter,
  createSecretStore,
  createTicketChangeNotifier,
  EmailEmulator,
  ExpoPushProvider,
  GraphileJobPublisher,
  InMemoryJobQueue,
  InMemoryRealtimeFanout,
  installedMessaging,
  isMessagingSurfaceEnabled,
  messagingPlatformsFromEnv,
  modelCatalogSourcesFromEnv,
  ObjectAgentHomeStore,
  PiOAuthLogins,
  PostgresRealtimeFanout,
  PrismaPushTokenStore,
  piSessionsRoot,
  RunJobPublisher,
  RunStarter,
  resolveDeploymentModel,
  SpaceMemoryProviderResolver,
  StripeBillingProvider,
  sandboxProviderOptionsFromEnv,
  stripeBillingConfigFromEnv,
  UserDeviceHub,
  UserDevices,
  userDeviceForwardSecret,
  userDeviceInternalAddress,
  verifyModelServesAgents,
  WorkActivities,
  withHostComputerScreen,
  withSecretPersistence,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import {
  isLocalhostOrLoopbackIp,
  localRequestAllowed,
  PLUGIN_SUBMISSIONS_PATH,
  SERVER_BUILD_HEADER,
} from "@rakazo/contracts";
import { encryptionKeyWarning } from "@rakazo/core";
import type { Pool, PrismaClient } from "@rakazo/db";
import {
  configureProviderTransactionPool,
  createBoardEvents,
  createDb,
  createPool,
  createThreadEvents,
  describeRowSecurity,
  IsolationError,
  installAuditEventStore,
  installSecurityEventStore,
  observeThreadChanges,
  parsePositiveInteger,
  requireMembership,
  rowSecurityWarning,
  runAsSystem,
  SemanticFactStore,
  verifyContentKeys,
} from "@rakazo/db";
import type { Logger } from "@rakazo/logging";
import {
  createServiceLogger,
  enrichLogContext,
  getLogger,
  installLogger,
  SERVICE_NAMES,
} from "@rakazo/logging";
import { requestLogging } from "@rakazo/logging/hono";
import { MarkdownMemoryStore } from "@rakazo/memory";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { finishStalledOrganizationDeletions } from "./account-deletion.js";
import { mountAccountExportRoute } from "./account-export.js";
import { mountAccountImportRoute } from "./account-import.js";
import { storeInboundAttachment } from "./artifacts.js";
import { mountAuditExportRoute } from "./audit-export.js";
import { createBillingService } from "./billing.js";
import { mountBillingRoutes } from "./billing-webhook.js";
import { clientBuildMiddleware, readDeployedWebBuild } from "./client-build.js";
import {
  clientIpMiddleware,
  createClientIpResolver,
  defaultTrustedProxies,
  requestClientIp,
} from "./client-ip.js";
import { cspReportRoutes } from "./csp-report.js";
import { configuredEmailProvider } from "./email.js";
import { mountEmailInboundRoute } from "./email-inbound.js";
import type { AppEnv } from "./env.js";
import { loadEnv } from "./env.js";
import { healthRoutes } from "./health.js";
import { homeRetentionSweep } from "./home-retention.js";
import { startHourlySweep } from "./hourly-sweep.js";
import { trackInFlightRequests } from "./in-flight-requests.js";
import { ensureLocalIdentity, requestLocalSessionId } from "./local-identity.js";
import { mountLocalComputerHost } from "./local-settings.js";
import { moveMcpArgsIntoSecrets } from "./mcp-args-migration.js";
import { startMessagingRuntime } from "./messaging-runtime.js";
import { ModelCatalogSync } from "./model-catalog-sync.js";
import { monitoringRoutes } from "./monitoring.js";
import { pluginSubmissionRoutes } from "./plugin-submissions.js";
import { rpcBodyLimit } from "./request-body-limit.js";
import { createRouter } from "./router.js";
import { handleRpcError } from "./rpc-errors.js";
import { mountScreenTarget } from "./screen-proxy.js";
import { mountScriptAssets } from "./script-assets.js";
import { mountSharedPages } from "./shared-pages.js";
import { createSpeechSummarizer } from "./speech-summary.js";
import { settleWithTimeout } from "./team-chat-startup.js";
import { mountUserDeviceRoutes } from "./user-devices.js";
import { mountVoiceHttpRoutes } from "./voice.js";
import { mountWebhookHttpRoutes } from "./webhook.js";

// Deploys give the old API 30 seconds to stop before killing it.
const REQUEST_DRAIN_MS = 20_000;

export interface AppHandles {
  app: Hono;
  prisma: PrismaClient;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
  composio?: ComposioProvider;
  connectors: ConnectorRegistry;
  messaging?: MessagingSurface;
  email?: TransactionalEmailProvider;
  notifications: NotificationProvider;
  executor: ReturnType<typeof createRunExecutor>;
  runtime: AgentRuntime;
  awaitIdle?: () => Promise<void>;
  backgroundFailures?: () => Array<{ name: string; count: number }>;
  /** Node `upgrade` listener for desktop device sockets; absent when the feature is off. */
  handleUpgrade?: UserDeviceHub["handleUpgrade"];
  stop: () => Promise<void>;
}

// Startup and everything it schedules (pollers, team chat, the in-memory job
// queue, retries) runs across tenants. Requests start without a context and get
// one per route: tenant for signed-in procedures, system for auth and webhooks.
export function createApp(overrides: CreateAppOverrides = {}): Promise<AppHandles> {
  return runAsSystem("api startup and background work", () => buildApp(overrides));
}

type CreateAppOverrides = Partial<AppEnv> & {
  prisma?: PrismaClient;
  realtime?: RealtimeFanout;
  sandbox?: SandboxProvider;
  composio?: ComposioProvider;
  /** Test-only connector providers registered beside the configured ones. */
  connectors?: ConnectorProvider[];
  pipedream?: ManagedConnectorProvider;
  messaging?: MessagingSurface;
  email?: TransactionalEmailProvider;
  notifications?: NotificationProvider;
  billing?: BillingProvider;
  remoteConnectors?: RemoteConnectorDependencies;
  pluginRepoFetcher?: PluginRepoFetcher;
  pluginMarketplaceRead?: PluginTextReader;
  modelConnectionFetch?: typeof fetch;
  logger?: Logger;
  runtime?: AgentRuntime;
  contextStrategy?: AgentContextStrategy;
  /** Test-only stand-in for desktops connected to this server. */
  userDevices?: UserDeviceGateway;
  /** Test-only present moment the agent is told. */
  now?: () => Date;
};

async function buildApp(overrides: CreateAppOverrides): Promise<AppHandles> {
  const {
    prisma: prismaOverride,
    realtime: realtimeOverride,
    sandbox: sandboxOverride,
    composio: composioOverride,
    connectors: connectorOverrides = [],
    pipedream: pipedreamOverride,
    messaging: messagingOverride,
    email: emailOverride,
    notifications: notificationsOverride,
    billing: billingOverride,
    remoteConnectors,
    modelConnectionFetch,
    pluginRepoFetcher,
    pluginMarketplaceRead,
    logger: loggerOverride,
    runtime: runtimeOverride,
    contextStrategy,
    userDevices: userDevicesOverride,
    now,
    ...envOverrides
  } = overrides;
  const env = { ...loadEnv(process.env), ...envOverrides };
  if (!isLocalhostOrLoopbackIp(env.apiHost))
    throw new Error("Rakazo local mode requires API_HOST to be a loopback host");
  const runtimeEnv: RunRuntimeEnv = { ...env, inboundEmailDomain: env.inboundEmail?.domain };
  const logger = loggerOverride ?? createServiceLogger({ service: SERVICE_NAMES.api });
  installLogger(logger);
  const poolMax = parsePositiveInteger(process.env.DB_POOL_MAX, 4);
  configureProviderTransactionPool(poolMax);
  const created = prismaOverride
    ? { prisma: prismaOverride, pool: undefined }
    : createDb(env.databaseUrl, {
        poolMax,
        applicationName: "rakazo-api",
        keyProvider: contentKeyProviderFromEnv(),
        encryptContent: env.contentEncryption,
      });
  let { prisma } = created;
  // Built before anything listens, so a bad TRUSTED_PROXIES entry stops startup.
  const clientIp = createClientIpResolver({
    // Unset trusts the proxies a stack is built with: on loopback or on the API's own networks.
    // Trusting none would make the web proxy every client, one sign-in rate-limit bucket for all.
    trustedProxies: env.trustedProxies.length > 0 ? env.trustedProxies : defaultTrustedProxies(),
    header: env.clientIpHeader,
  });
  const rowSecurity = rowSecurityWarning(await describeRowSecurity(prisma));
  if (rowSecurity) logger.warn(rowSecurity);
  const weakEncryptionKey = encryptionKeyWarning(process.env);
  if (weakEncryptionKey) logger.warn(weakEncryptionKey);
  // Set once push delivery is configured below; thread changes before then have no cards.
  let workActivities: WorkActivities | undefined;
  // Every thread change this process commits also updates its users' live status cards.
  const realtime = observeThreadChanges(
    realtimeOverride ??
      (created.pool
        ? new PostgresRealtimeFanout({
            connectionString: env.realtimeDatabaseUrl,
            publisher: created.pool,
          })
        : new InMemoryRealtimeFanout()),
    (threadId) => workActivities?.threadChanged(threadId),
  );
  const secrets = createSecretStore(env.encryptionKey, process.env, realtime);
  await secrets.start();
  if (secrets.describe().capabilities.degraded)
    logger.warn("Secret storage degraded; encrypted credentials remain available");
  prisma = withSecretPersistence(prisma, secrets);
  const localIdentity = await ensureLocalIdentity(prisma);
  installSecurityEventStore(prisma);
  installAuditEventStore(prisma);
  const unreadableMasterKeys = await verifyContentKeys(prisma);
  if (unreadableMasterKeys.length)
    logger.error("Stored space keys need master keys that are not configured", undefined, {
      masterKeyIds: unreadableMasterKeys,
    });
  const analytics = createProductAnalytics();
  const events = createThreadEvents(prisma, realtime, {
    analytics,
    runSecretWriter: createRunSecretWriter(secrets),
  });
  const ticketBoardEnabled = env.ticketBoardEnabled;
  const boardEvents = createBoardEvents(realtime);

  const jobKind = env.wakeupDriver;
  const inMemoryJobs = jobKind === "memory" ? new InMemoryJobQueue() : undefined;
  // prismaOverride skips createDb, so there is no shared pool; keep a bounded one for jobs.
  let ownedJobPool: Pool | undefined;
  if (!inMemoryJobs && !created.pool) {
    ownedJobPool = createPool(env.databaseUrl, {
      poolMax: parsePositiveInteger(process.env.DB_POOL_MAX, 4),
      applicationName: "rakazo-api-jobs",
    });
  }
  const jobPool = created.pool ?? ownedJobPool;
  const shutdown = new AbortController();
  const catalogAdapters = await modelCatalogSourcesFromEnv();
  const modelCatalogSync = catalogAdapters.length
    ? new ModelCatalogSync(prisma, secrets, catalogAdapters)
    : undefined;
  const catalogSyncs = new Set<Promise<void>>();
  const synchronizeCatalogs = () => {
    if (!modelCatalogSync || shutdown.signal.aborted) return;
    const task = modelCatalogSync.syncAll(shutdown.signal).catch((error: unknown) => {
      if (!shutdown.signal.aborted)
        getLogger().error("model catalog synchronization failed", error);
    });
    catalogSyncs.add(task);
    void task.finally(() => catalogSyncs.delete(task));
  };
  const catalogTimer = modelCatalogSync ? setInterval(synchronizeCatalogs, 5 * 60_000) : undefined;
  catalogTimer?.unref();
  synchronizeCatalogs();
  // Chat starts in the process that receives it; the worker only takes what this one can't.
  const runs = inMemoryJobs ? undefined : new RunStarter(realtime, { signal: shutdown.signal });
  const jobs =
    inMemoryJobs ??
    new RunJobPublisher(
      prisma,
      new GraphileJobPublisher(
        jobPool ??
          (() => {
            throw new Error("Graphile job publisher requires a PostgreSQL pool");
          })(),
        prisma,
      ),
      runs!,
    );
  const ticketChanges = createTicketChangeNotifier({
    boardEvents,
    jobs,
    prisma,
    ticketBoardEnabled,
  });
  const hostComputer = sandboxProviderOptionsFromEnv();
  const sandbox: SandboxProvider =
    sandboxOverride ??
    (await createRunSandbox(env.sandboxProvider, {
      ...hostComputer,
      supervisorUrl: env.sandboxSupervisorUrl,
      supervisorToken: env.sandboxSupervisorToken,
      e2bApiKey: env.e2bApiKey,
      novitaApiKey: env.novitaApiKey,
      sandboxTemplate: env.sandboxTemplate,
      daytonaApiKey: env.daytonaApiKey,
      daytonaApiUrl: env.daytonaApiUrl,
      daytonaTarget: env.daytonaTarget,
      boatApiKey: env.boatApiKey,
      boatApiUrl: env.boatApiUrl,
      dataDir: env.dataDir,
      prisma,
      secrets,
    }));
  const semanticFacts = new SemanticFactStore(prisma);
  const memoryProviders = new SpaceMemoryProviderResolver(prisma, secrets, {
    createManagedMemoryProvider: (index) => createManagedMemoryProvider({ prisma, index, jobs }),
  });
  const oauthLogins = new PiOAuthLogins(undefined, { prisma, secrets });
  const home = createAgentHomeStore(env.dataDir, prisma);
  void home.removeStaleStaging().catch((error) => getLogger().error("home staging cleanup", error));
  const artifacts = createArtifactStore(env.dataDir, prisma);
  const memory = new MarkdownMemoryStore(prisma);
  // This process registers the inbound sink, so it must hold Telegram's getUpdates connection.
  const messagingPlatforms = messagingPlatformsFromEnv(env, { pollInboundMessages: true }).filter(
    (platform) => platform.provider !== "slack" || !env.slackClientId,
  );
  const legacyMessaging =
    messagingOverride ??
    (isMessagingSurfaceEnabled(messagingPlatforms, {
      deploymentModelConfigured: env.deploymentModelConfigured,
      openSignup: env.messagingOpenSignup,
    })
      ? new ChatSdkMessagingSurface(messagingPlatforms)
      : undefined);
  const { messaging, installations: messagingInstallations } = messagingOverride
    ? { messaging: messagingOverride, installations: undefined }
    : installedMessaging(prisma, secrets, env, legacyMessaging, jobs);
  const configuredEmail = emailOverride ?? configuredEmailProvider(env);
  const localEmailEmulator =
    !configuredEmail && env.emailEmulator
      ? new EmailEmulator((message) => {
          getLogger().info("email emulator captured message", {
            "email.subject": message.subject,
          });
        })
      : undefined;
  if (localEmailEmulator && !isLocalhostOrLoopbackIp(env.apiHost)) {
    throw new Error("EMAIL_EMULATOR requires API_HOST to be a loopback host");
  }
  const email: TransactionalEmailProvider | undefined = configuredEmail ?? localEmailEmulator;
  const emailErrorLogger = (message: string) => (error: unknown) => {
    if (error instanceof EmailRecipientRejectedError) {
      getLogger().warn(message, { "error.message": error.message });
    } else getLogger().error(message, error);
  };
  const onEmailError = emailErrorLogger("transactional email delivery failed");
  const stripeBilling = stripeBillingConfigFromEnv(env);
  const billingProvider: BillingProvider | undefined =
    billingOverride ?? (stripeBilling ? new StripeBillingProvider(stripeBilling) : undefined);
  const billing = billingProvider
    ? createBillingService({
        prisma,
        provider: billingProvider,
        sandbox,
        webOrigin: env.webOrigin,
        managedModelsAvailable: resolveDeploymentModel().configured,
        analytics,
      })
    : undefined;
  const modelCreditsEnabled = billing?.modelCreditsEnabled ?? false;
  await prisma.deploymentSettings.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      modelCreditsEnabled,
    },
    update: { modelCreditsEnabled },
  });
  const connectors = createConnectorRuntime(
    runtimeEnv,
    { prisma, secrets, events },
    {
      network: remoteConnectors,
      composio: composioOverride,
      pipedream: pipedreamOverride,
      connectors: connectorOverrides,
    },
  );
  const { mcpOAuth, mcp, pipedream, installed, integrationSettings, stack } = connectors;
  const runtime =
    runtimeOverride ??
    (await createAgentRuntimeSelection({
      defaultRuntime: env.agentRuntime,
      routes: env.agentRuntimeRoutes,
      dataDir: env.dataDir,
      piSessionRoot: env.piSessionRecording ? piSessionsRoot(env.dataDir) : undefined,
    }));
  const pushTokens = new PrismaPushTokenStore(prisma, env.encryptionKey);
  const notifications =
    notificationsOverride ??
    new ExpoPushProvider(pushTokens, {
      jobs,
      accessToken: env.expoAccessToken,
      voip: await createApnsVoipProvider(env.apnsVoip),
    });
  const activityPush = await createApnsActivityProvider(env.apnsVoip);
  if (activityPush) workActivities = new WorkActivities(prisma, env.encryptionKey, activityPush);
  const userDeviceSecret = userDeviceForwardSecret(env.encryptionKey);
  const userDeviceHub = env.userDevicesEnabled
    ? new UserDeviceHub({ prisma, address: userDeviceInternalAddress(env.apiHost, env.port) })
    : undefined;
  const userDevices = userDeviceHub
    ? new UserDevices({ prisma, forwardSecret: userDeviceSecret, hub: userDeviceHub })
    : undefined;
  const mcpArgsMove = moveMcpArgsIntoSecrets(prisma, secrets, { signal: shutdown.signal })
    .then(({ moved }) => {
      if (moved) getLogger().info("mcp server arguments encrypted", { count: moved });
    })
    .catch((error) => {
      if (!shutdown.signal.aborted) getLogger().error("mcp server arguments move failed", error);
    });
  // One provider instance so emulator launches and polls share the same Map.
  const cloudAgent = createCloudAgentConnection({
    CLOUD_AGENT_PROVIDER: env.cloudAgentProvider,
    CURSOR_API_KEY: env.cursorApiKey,
    CLOUD_AGENT_SPACE_ID: env.cloudAgentSpaceId,
  });
  const paymentWallet = await createPaymentWalletProvider({
    PAYMENT_WALLET_PROVIDER: env.paymentWalletProvider,
    PAYMENT_WALLET_CLIENT_ID: env.paymentWalletClientId,
  });
  // One cache serves models.list, selection validation, and run-time model
  // resolution alike, so a list call warms the run path in this process.
  const codexCatalog = new CodexCatalogCache();
  // One instance: chat runs submit videos and, in single-process mode, background polls finish them.
  const mediaGeneration = createMediaGenerationProvider();
  const { executor, jobHandlers, archiveConversationMemory } = createRunRuntime(
    runtimeEnv,
    connectors,
    {
      billingEnabled: modelCreditsEnabled,
      mediaGeneration,
      contextStrategy,
      prisma,
      runtime,
      codexCatalog,
      sandbox,
      memory,
      memoryProviders,
      home,
      artifacts,
      secretStore: secrets,
      secretHttp: remoteConnectors,
      notifications,
      jobs,
      events,
      onTicketChange: ticketChanges,
      email,
      messaging,
      cloudAgent,
      userDevices:
        userDevicesOverride ??
        withHostComputerScreen(userDevices, {
          prisma,
          sandboxKind: env.sandboxProvider,
          url: hostComputer.hostComputerUrl,
          token: hostComputer.hostComputerToken,
        }),
      paymentWallet,
      shutdownSignal: shutdown.signal,
      now,
    },
  );

  if (inMemoryJobs) {
    await inMemoryJobs.start(jobHandlers);
  }
  runs?.attach(jobHandlers);
  const reconciler = inMemoryJobs
    ? createRunReconciler({
        prisma,
        jobs,
        events,
        connector: connectors.stack.connector,
        shutdownSignal: shutdown.signal,
        notifications,
        cloudAgent,
        paymentWallet,
        mediaGeneration,
        billingEnabled: modelCreditsEnabled,
      })
    : undefined;
  reconciler?.start();
  // Self-hosted deployments without billing keep every saved home.
  const stopHomeRetention =
    email && billingProvider && home instanceof ObjectAgentHomeStore
      ? startHourlySweep(
          homeRetentionSweep({
            prisma,
            email,
            appUrl: new URL("/app", env.webOrigin).href,
            onError: (error) => getLogger().error("saved home retention failed", error),
          }),
          (error) => getLogger().error("saved home retention failed", error),
        )
      : undefined;

  const stopOrganizationDeletions = startHourlySweep(
    finishStalledOrganizationDeletions({
      prisma,
      sandbox,
      home,
      jobs,
      artifacts,
      dataDir: env.dataDir,
      messagingInstallations,
      secrets,
      billing,
      memoryProviders,
      semanticFacts,
    }),
    (error) => getLogger().error("stalled organization deletion failed", error),
  );

  const router = createRouter({
    modelCatalogSync,
    speechSummary:
      env.voiceSummaryMinChars === undefined
        ? undefined
        : {
            minChars: env.voiceSummaryMinChars,
            summarize: createSpeechSummarizer({
              prisma,
              runtime,
              resolveModel: executor.resolveModel,
            }),
          },
    analytics,
    pluginRepoFetcher,
    pluginMarketplaceRead,
    cloudAgent,
    paymentWallet,
    codexCatalog,
    prisma,
    notifications,
    pushTokens,
    workActivities,
    events,
    ticketChanges,
    boardEvents,
    jobs,
    sandbox,
    memory,
    memoryProviders,
    semanticFacts,
    archiveConversationMemory,
    home,
    secrets,
    oauthLogins,
    integrationSettings,
    mcpOAuth,
    mcp,
    composio: stack.composio,
    connectors: stack.connector,
    remoteConnectors,
    modelConnectionFetch,
    // The scripted runtime never calls a provider, so neither does its connect.
    modelConnectionCheck: env.agentRuntime === "pi" ? verifyModelServesAgents : undefined,
    artifacts,
    email,
    onEmailError,
    dataDir: env.dataDir,
    billing,
    messagingInstallations,
    messaging: {
      enabled: Boolean(messaging),
      providers: messaging?.platforms().map((platform) => platform.provider) ?? [],
      addresses: Object.fromEntries(
        (messaging?.platforms() ?? []).flatMap((platform) =>
          platform.address ? [[platform.provider, platform.address]] : [],
        ),
      ),
      openSignup: env.messagingOpenSignup,
    },
    env: {
      inboundEmailDomain: env.inboundEmail?.domain,
      phoneCallsEnabled: env.phoneCallsEnabled,
      phoneCallRingSeconds: env.phoneCallRingSeconds,
      ticketBoardEnabled,
      navLinks: env.navLinks,
      adminEmails: env.adminEmails,
      maxUploadSizeBytes: env.maxUploadSizeBytes,
      maxAttachmentsPerMessage: env.maxAttachmentsPerMessage,
      agentRuntime: env.agentRuntime,
      defaultProvider: env.defaultProvider,
      defaultModel: env.defaultModel,
      teamChatJudgeProvider: env.teamChatJudgeProvider,
      teamChatJudgeModel: env.teamChatJudgeModel,
      deploymentModelConfigured: env.deploymentModelConfigured,
      deploymentModelHostCredentials: env.deploymentModelHostCredentials,
      webOrigin: env.webOrigin,
      privacyPolicyUrl: env.privacyPolicyUrl,
      screenProxySecret: env.screenProxySecret,
      sandboxProvider: env.sandboxProvider,
      gitSha: env.gitSha,
      integrationsCatalogUrl: env.integrationsCatalogUrl,
      mcpAllowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
      localMemoryAllowedUrls: env.localMemoryAllowedUrls,
      desktopHostChoiceEnabled: Boolean(env.desktopStackToken),
      computerSettingsEnabled: env.computerSettingsEnabled,
      mcpStdioEnabled: env.mcpStdioEnabled,
      mcpStdioAllowedCommands: env.mcpStdioAllowedCommands,
    },
  });
  const rpc = new RPCHandler(router, {
    clientInterceptors: [onError((error, { path, signal }) => handleRpcError(error, path, signal))],
  });
  const app = new Hono();
  const inFlight = trackInFlightRequests();
  app.use("*", inFlight.middleware);
  app.use("*", requestLogging(logger));
  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    const origin = c.req.header("origin");
    if (
      !localRequestAllowed(host, (name) => c.req.header(name)) ||
      (origin !== undefined && !isTrustedOrigin(origin, env))
    ) {
      return c.json({ error: "Local requests only" }, 403);
    }
    await next();
  });
  app.use("*", clientIpMiddleware(clientIp, env.clientIpHeader));
  app.use(
    "*",
    cors({
      origin: (origin, c) => {
        // Anyone may submit a plugin from any site; the endpoint reads no cookies.
        if (c.req.path === PLUGIN_SUBMISSIONS_PATH) return "*";
        if (!origin) return env.webOrigin;
        return isTrustedOrigin(origin, env) ? origin : "";
      },
      credentials: false,
      exposeHeaders: [SERVER_BUILD_HEADER],
    }),
  );
  for (const path of ["/api/local-identity", "/api/app-capabilities", "/rpc/*"]) {
    app.use(path, async (c, next) => {
      await next();
      c.header("cache-control", "no-store");
    });
  }
  app.get("/api/app-capabilities", (c) =>
    c.json({
      billing: Boolean(billing),
      crispWebsiteId: billing ? (env.crispWebsiteId ?? null) : null,
    }),
  );
  app.get("/api/local-identity", (c) => c.json(localIdentity));
  if (localEmailEmulator && env.nodeEnv === "development") {
    app.get(
      "/api/dev/emails",
      () =>
        new Response(JSON.stringify(localEmailEmulator.sent), {
          headers: { "cache-control": "no-store", "content-type": "application/json" },
        }),
    );
  }
  app.route(
    "/",
    monitoringRoutes(env.browserMonitoring, fetch, async () => localIdentity.id),
  );
  app.route("/", cspReportRoutes(requestClientIp));
  app.route(
    "/",
    pluginSubmissionRoutes({
      prisma,
      email,
      adminEmails: env.adminEmails,
      webOrigin: env.webOrigin,
      clientIp: requestClientIp,
      onEmailError,
    }),
  );
  mountScreenTarget(app, prisma, env.screenProxySecret);
  mountScriptAssets(app);
  mountSharedPages(app, prisma, requestClientIp);
  // Webhooks authenticate a bot or provider, then resolve the tenant from it.
  for (const [path, reason] of [
    ["/api/v1/bots/*", "bot webhook"],
    ["/api/v1/email/*", "inbound email"],
    ["/api/v1/messaging/*", "messaging webhook"],
    ["/api/v1/phone/*", "messaging webhook"],
  ] as const) {
    app.use(path, (_c, next) => runAsSystem(reason, next));
  }
  mountLocalComputerHost(app, {
    token: env.desktopStackToken,
    sandboxProvider: env.sandboxProvider,
    prisma,
  });
  const requestSession = async (request: Request) => {
    const actor = await actorFromMembership(
      requireMembership(prisma, localIdentity.id, request.headers.get("x-rakazo-space-id")),
    );
    return (
      actor && {
        actor: { ...actor, isDeploymentOwner: true },
        sessionId: requestLocalSessionId(request),
      }
    );
  };
  const sessionActor = async (request: Request) => (await requestSession(request))?.actor ?? null;
  if (userDeviceHub && userDevices) {
    mountUserDeviceRoutes(app, {
      prisma,
      hub: userDeviceHub,
      devices: userDevices,
      forwardSecret: userDeviceSecret,
      session: async (request) => ({
        userId: localIdentity.id,
        sessionId: requestLocalSessionId(request),
      }),
      trustedOrigin: (origin) => isTrustedOrigin(origin, env),
    });
  }
  if (messagingInstallations) {
    // Slack's registered redirect; the signed-in app finishes it so only the installer can.
    app.get("/api/v1/messaging/install/slack/callback", (c) => {
      const target = new URL("/messaging/slack/callback", env.webOrigin);
      target.search = new URL(c.req.url).search;
      return c.redirect(target.toString());
    });
  }
  // A page on another site may not write through this session's /rpc. A browser sends Origin on
  // every cross-site POST; a request with none is a native client or the desktop shell.
  app.use("/rpc/*", async (c, next) => {
    if (RPC_WRITE_METHODS.has(c.req.method) && !rpcOriginAllowed(c.req.header("origin"), env)) {
      return c.json({ error: "Origin not allowed" }, 403);
    }
    await next();
  });
  app.use(
    "/rpc/*",
    clientBuildMiddleware({
      webBuild: readDeployedWebBuild(),
      minimums: env.minimumClientBuilds ?? {},
    }),
  );
  const limitRpcBody = rpcBodyLimit(env.maxUploadSizeBytes);
  app.use("/rpc/*", async (c, next) => {
    const tooLarge = await limitRpcBody(c);
    if (tooLarge) return tooLarge;
    const session = await requestSession(c.req.raw);
    const actor = session?.actor ?? null;
    if (actor) {
      enrichLogContext({ "user.id": actor.userId, "space.id": actor.spaceId });
    }
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: "/rpc",
      context: {
        actor,
        sessionId: session?.sessionId,
        signal: c.req.raw.signal,
        // Same user in the same space, so leaving the space also ends a stream.
        // A database failure rejects this check; only a missing membership is unauthorized.
        stillAuthorized: async () => {
          const current = await sessionActor(c.req.raw);
          return Boolean(
            actor && current?.userId === actor.userId && current.spaceId === actor.spaceId,
          );
        },
      },
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });
  mountAccountExportRoute(app, { prisma, artifacts, home });
  mountAuditExportRoute(app, { prisma, sessionActor });
  mountVoiceHttpRoutes(app, { prisma, secrets, env }, async (c) => {
    const actor = await sessionActor(c.req.raw);
    if (actor) enrichLogContext({ "user.id": actor.userId, "space.id": actor.spaceId });
    return actor;
  });
  mountAccountImportRoute(
    app,
    {
      prisma,
      sandbox,
      home,
      jobs,
      artifacts,
      dataDir: env.dataDir,
      messagingInstallations,
      maxArtifactBytes: env.maxUploadSizeBytes,
    },
    sessionActor,
  );
  mountWebhookHttpRoutes(app, { prisma, secrets, events, jobs });
  if (env.inboundEmail) {
    mountEmailInboundRoute(app, {
      prisma,
      events,
      jobs,
      ...env.inboundEmail,
      storeAttachment: ({ spaceId, userId, ...input }) =>
        storeInboundAttachment(
          { prisma, artifacts, maxUploadSizeBytes: env.maxUploadSizeBytes },
          { spaceId, userId },
          input,
        ),
    });
  }
  if (billing && billingProvider) {
    mountBillingRoutes(app, {
      billing,
      provider: billingProvider,
      webOrigin: env.webOrigin,
      authenticate: sessionActor,
    });
  }
  const messagingRuntime = messaging
    ? await startMessagingRuntime({
        app,
        prisma,
        events,
        jobs,
        sandbox,
        secrets,
        artifacts,
        runtime,
        env,
        messaging,
        messagingInstallations,
      })
    : undefined;

  app.route(
    "/",
    healthRoutes(
      () => ({
        runtime: env.agentRuntime,
        sandbox: env.sandboxProvider,
        integrations: [stack.composio, pipedream].flatMap((provider) =>
          provider ? [provider.describe().id] : [],
        ),
        messaging: Boolean(messaging),
        email: email?.describe().id ?? null,
        billing: billingProvider?.describe().id ?? null,
        jobs: jobKind,
        realtime: realtime.describe().id,
        secrets: secrets.describe(),
        degraded: secrets.describe().capabilities.degraded ?? false,
        revision: env.gitSha ?? null,
      }),
      // The statement timeout ends a stuck probe on the server too, freeing its connection.
      () =>
        prisma.$transaction([
          prisma.$executeRaw`SET LOCAL statement_timeout = 1500`,
          prisma.$queryRaw`SELECT 1`,
        ]),
    ),
  );

  return {
    app,
    prisma,
    jobs,
    sandbox,
    composio: stack.composio,
    connectors: stack.connector,
    messaging,
    email,
    notifications,
    executor,
    runtime,
    awaitIdle: inMemoryJobs ? () => inMemoryJobs.awaitIdle() : undefined,
    backgroundFailures: inMemoryJobs ? () => inMemoryJobs.failureCounts() : undefined,
    handleUpgrade: userDeviceHub?.handleUpgrade,
    stop: async () => {
      // Handlers still running would otherwise query the pool after it ends.
      const requestsSettled = settleWithTimeout(inFlight.settled(), REQUEST_DRAIN_MS);
      // Abort in-flight continueRun boot waits before draining jobs so stop() cannot sit
      // on waitForComputerReady for the full boot-wait window during shared Postgres journeys.
      shutdown.abort();
      if (catalogTimer) clearInterval(catalogTimer);
      await Promise.allSettled(catalogSyncs);
      // Aborted runs hand themselves back while realtime is still open to announce them.
      const runsStopped = runs?.stop();
      await userDeviceHub?.close();
      oauthLogins.abortAll();
      await messagingRuntime?.stop();
      await stopHomeRetention?.();
      await stopOrganizationDeletions();
      await reconciler?.stop();
      await mcpArgsMove;
      await runsStopped;
      await requestsSettled;
      await email?.drain?.();
      await jobs.close();
      await secrets.close();
      await realtime.close();
      await mcp.close();
      await installed.close();
      await prisma.$disconnect().catch(() => undefined);
      await created.pool?.end().catch(() => undefined);
      await ownedJobPool?.end().catch(() => undefined);
      await analytics?.flush();
      await logger.flush({ timeoutMs: 2_000 });
    },
  };
}

export function isTrustedOrigin(origin: string, env: OriginEnv) {
  if (origin === "rakazo://") return true;
  return trustedRequestOrigins(env).includes(origin);
}

type OriginEnv = Pick<AppEnv, "webOrigin" | "apiUrl">;

/** /rpc methods that can change something; a GET from another site only reads. */
const RPC_WRITE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Whether a write over /rpc may come from this Origin. Browser writes must come from the app;
 * native clients may omit Origin or use the app scheme.
 */
export function rpcOriginAllowed(origin: string | undefined, env: OriginEnv): boolean {
  return origin === undefined || isTrustedOrigin(origin, env);
}

export function trustedRequestOrigins(env: OriginEnv): string[] {
  const values = [env.webOrigin, env.apiUrl];
  return values.flatMap((value) => {
    try {
      const url = new URL(value);
      if (!isLocalhostOrLoopbackIp(url.hostname)) return [];
      const port = url.port ? `:${url.port}` : "";
      return [
        url.origin,
        ...["localhost", "127.0.0.1", "[::1]"].map((host) => `${url.protocol}//${host}${port}`),
      ];
    } catch {
      return [];
    }
  });
}

/**
 * No membership is no actor, which the RPC layer answers as 401. A database
 * failure, including the deployment-settings lookup, must stay a server error
 * so a blip does not look like a rejected session.
 */
export async function actorFromMembership(membership: Promise<Actor>): Promise<Actor | null> {
  try {
    return await membership;
  } catch (error) {
    if (error instanceof IsolationError) return null;
    throw error;
  }
}
