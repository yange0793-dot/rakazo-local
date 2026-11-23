import { Trans } from "@lingui/react/macro";
import type { LinkFavicons } from "@rakazo/chat-ui/web";
import { LinkFaviconsContext, RemoteImagesContext } from "@rakazo/chat-ui/web";
import { analyticsScreen } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { CallLayout } from "./components/call/CallLayout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { MarkdownLinkPrompt } from "./components/markdown-link-prompt";
import { PageLoading } from "./components/PageLoading";
import { SubscriptionGate } from "./components/SubscriptionGate";
import { getTicketBoardEnabled, subscribeTicketBoardEnabled } from "./lib/bootstrap";
import { desktopBridge } from "./lib/desktop";
import { LocalIdentityProvider } from "./lib/local-identity";
import { syncWebLogoAvatarIdentity } from "./lib/logo-avatar-activity";
import { identifyMonitoringUser } from "./lib/monitoring";
import { markAfterPaint, markOnce } from "./lib/performance";
import { lazyComponent } from "./lib/preload-recovery";
import { QueryUserProvider, setQueryUser } from "./lib/query";
import { remoteImagesPreference } from "./lib/remote-images-preference";
import { rpc } from "./lib/rpc";
import { MCP_OAUTH_CALLBACK_PATH, SLACK_INSTALL_CALLBACK_PATH } from "./lib/callback-paths";
import { IntegrationCallbackPage } from "./pages/IntegrationCallback";
import { IntegrationSetupPage } from "./pages/IntegrationSetup";
import { McpOAuthCallbackPage } from "./pages/McpOAuthCallback";
import { SharedPagePage } from "./pages/SharedPage";
import { ShellPage } from "./pages/Shell";
import { SlackInstallCallbackPage } from "./pages/SlackInstallCallback";

const OnboardingPage = lazyComponent(() =>
  import("./pages/Onboarding").then((module) => module.OnboardingPage),
);
const NotFoundPage = lazyComponent(() =>
  import("./pages/NotFound").then((module) => module.NotFoundPage),
);
const ArtifactsPage = lazyComponent(() =>
  import("./pages/Artifacts").then((module) => module.ArtifactsPage),
);
const BoardPage = lazyComponent(() => import("./pages/Board").then((module) => module.BoardPage));
const AdminPluginsPage = lazyComponent(() =>
  import("./pages/AdminPluginsPage").then((module) => module.AdminPluginsPage),
);
const AdminAccessPage = lazyComponent(() =>
  import("./pages/AdminAccessPage").then((module) => module.AdminAccessPage),
);
const NavLinkPage = lazyComponent(() =>
  import("./pages/NavLinkPage").then((module) => module.NavLinkPage),
);
const InvitePage = lazyComponent(() =>
  import("./pages/Invite").then((module) => module.InvitePage),
);

const linkFavicons: LinkFavicons = {
  load: (origin) => rpc.links.favicon({ origin }),
};

export function App() {
  const loadRemoteImages = remoteImagesPreference.use();
  return (
    <RemoteImagesContext.Provider value={loadRemoteImages}>
      <LinkFaviconsContext.Provider value={linkFavicons}>
        <ErrorBoundary fallback={<AppFailed />}>
          {window.location.pathname === "/integrations/callback" ? (
            <IntegrationCallbackPage />
          ) : (
            <LocalApp />
          )}
        </ErrorBoundary>
      </LinkFaviconsContext.Provider>
    </RemoteImagesContext.Provider>
  );
}

function LocalApp() {
  const ticketBoardEnabled = useSyncExternalStore(
    subscribeTicketBoardEnabled,
    getTicketBoardEnabled,
    () => false,
  );
  const { pathname } = useLocation();
  const screen = analyticsScreen(pathname);
  const [user, setUser] = useState<{
    id: string;
    name: string;
    email: string;
    image: null;
  } | null>(null);
  const [identityError, setIdentityError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const lastScreen = useRef<string | undefined>(undefined);

  const refreshIdentity = useCallback(async () => {
    const me = await rpc.me();
    setUser({ id: me.userId, name: me.name, email: me.email, image: null });
    setIdentityError(false);
  }, []);

  useEffect(() => {
    let active = true;
    void refreshIdentity().catch(() => {
      if (active) setIdentityError(true);
    });
    return () => {
      active = false;
    };
  }, [attempt, refreshIdentity]);

  useEffect(() => {
    if (user) void identifyMonitoringUser(true);
  }, [user?.id]);

  useEffect(() => {
    if (!user) {
      lastScreen.current = undefined;
      return;
    }
    if (!screen) return;
    const key = `${user.id}:${screen}`;
    if (lastScreen.current === key) return;
    lastScreen.current = key;
    void Promise.resolve()
      .then(() => rpc.analytics.screen({ screen, surface: desktopBridge() ? "desktop" : "web" }))
      .catch(() => undefined);
  }, [screen, user?.id]);

  useLayoutEffect(() => {
    syncWebLogoAvatarIdentity(user?.id ?? null);
  }, [user?.id]);

  useEffect(() => {
    setQueryUser(user?.id ?? null);
  }, [user?.id]);

  useLayoutEffect(() => {
    if (!user) return;
    markOnce("rk:renderer:identity-committed");
    markAfterPaint("rk:renderer:identity-painted");
  }, [user?.id]);

  if (!user && !identityError) return <PageLoading data-rakazo-app-state="identity-pending" />;
  if (!user) {
    return (
      <div className="grid h-full place-items-center bg-background px-6 text-center">
        <div className="flex flex-col items-center">
          <p className="text-body text-muted-foreground">
            <Trans>Can&apos;t reach the server.</Trans>
          </p>
          <Button
            variant="secondary"
            className="mt-4"
            onClick={() => setAttempt((value) => value + 1)}
          >
            <Trans>Retry now</Trans>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <QueryUserProvider value={user.id}>
      <LocalIdentityProvider value={{ user, refresh: refreshIdentity }}>
        <MarkdownLinkPrompt>
          <div className="h-full" data-rakazo-app-state="ready">
            <Suspense fallback={<PageLoading />}>
              <Routes>
                <Route path="/" element={<Navigate to="/app" replace />} />
                <Route path="/p/:slugToken" element={<SharedPagePage />} />
                <Route path={MCP_OAUTH_CALLBACK_PATH} element={<McpOAuthCallbackPage />} />
                <Route path={SLACK_INSTALL_CALLBACK_PATH} element={<SlackInstallCallbackPage />} />
                <Route path="/integrations/setup" element={<IntegrationSetupPage />} />
                <Route path="/admin/plugins" element={<AdminPluginsPage />} />
                <Route path="/invite/:token" element={<InvitePage />} />
                <Route path="/admin/access" element={<AdminAccessPage />} />
                <Route
                  element={
                    <SubscriptionGate fallback={<PageLoading />}>
                      <Outlet />
                    </SubscriptionGate>
                  }
                >
                  <Route path="/app" element={<ShellPage />} />
                  <Route path="/app/g/:groupId" element={<ShellPage />} />
                  <Route path="/app/:botId" element={<ShellPage />} />
                  <Route element={<CallLayout />}>
                    <Route path="/onboarding/:step?" element={<OnboardingPage />} />
                    <Route path="/app/artifacts" element={<ArtifactsPage />} />
                    <Route path="/app/artifacts/:artifactId" element={<ArtifactsPage />} />
                    {ticketBoardEnabled ? (
                      <Route path="/app/board" element={<BoardPage />} />
                    ) : null}
                    <Route path="/app/x/:linkId" element={<NavLinkPage />} />
                  </Route>
                </Route>
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </Suspense>
          </div>
        </MarkdownLinkPrompt>
      </LocalIdentityProvider>
    </QueryUserProvider>
  );
}

function AppFailed() {
  return (
    <div
      className="grid h-full place-items-center bg-background px-6 text-center"
      data-rakazo-app-state="failed"
    >
      <div className="flex flex-col items-center">
        <p className="text-body text-muted-foreground/80">
          <Trans>Something went wrong. Try again.</Trans>
        </p>
        <div className="mt-4">
          <Button variant="secondary" onClick={() => window.location.reload()}>
            <Trans>Refresh</Trans>
          </Button>
        </div>
      </div>
    </div>
  );
}
