import React, { Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AppShell } from './components/layout/app-shell';

const LandingPage = React.lazy(() => import('./pages/landing').then(m => ({ default: m.LandingPage })));
const DashboardPage = React.lazy(() => import('./pages/dashboard').then(m => ({ default: m.DashboardPage })));
const LoginPage = React.lazy(() => import('./pages/login').then(m => ({ default: m.LoginPage })));
const JobsPage = React.lazy(() => import('./pages/jobs').then(m => ({ default: m.JobsPage })));
const JobDetailPage = React.lazy(() => import('./pages/job-detail').then(m => ({ default: m.JobDetailPage })));
const JobLogsPage = React.lazy(() => import('./pages/job-logs').then(m => ({ default: m.JobLogsPage })));
const ReposPage = React.lazy(() => import('./pages/repos').then(m => ({ default: m.ReposPage })));
const AddBitbucketRepoPage = React.lazy(() => import('./pages/repos/add-bitbucket').then(m => ({ default: m.AddBitbucketRepoPage })));
const AddBitbucketWorkspacePage = React.lazy(() => import('./pages/repos/add-bitbucket-workspace').then(m => ({ default: m.AddBitbucketWorkspacePage })));
const StatsPage = React.lazy(() => import('./pages/stats').then(m => ({ default: m.StatsPage })));
const SettingsPage = React.lazy(() => import('./pages/settings').then(m => ({ default: m.SettingsPage })));
const VcsCredentialsPage = React.lazy(() => import('./pages/vcs-credentials').then(m => ({ default: m.VcsCredentialsPage })));
const NotFoundPage = React.lazy(() => import('./pages/not-found').then(m => ({ default: m.NotFoundPage })));

import './app.css';

import { ThemeProvider } from './lib/theme';
import { useIsDarkMode } from './hooks/use-is-dark-mode';
import { SmoothScroll } from './components/motion/smooth-scroll';

function ToasterWrapper() {
  const isDark = useIsDarkMode();
  return (
    <Toaster
      theme={isDark ? 'dark' : 'light'}
      position="bottom-right"
      closeButton
      gap={8}
      toastOptions={{
        duration: 4000,
        classNames: {
          toast: 'codra-toast',
          title: 'codra-toast-title',
          description: 'codra-toast-description',
          actionButton: 'codra-toast-action',
          cancelButton: 'codra-toast-cancel',
          closeButton: 'codra-toast-close',
          icon: 'codra-toast-icon',
          loader: 'codra-toast-loader',
          success: 'codra-toast-success',
          error: 'codra-toast-error',
          warning: 'codra-toast-warning',
          info: 'codra-toast-info',
          loading: 'codra-toast-loading',
        },
      }}
    />
  );
}

class ErrorBoundary extends React.Component<{ fallback?: React.ReactNode, children: React.ReactNode }, { error: Error | null }> {
  constructor(props: { fallback?: React.ReactNode, children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }
  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex flex-col items-center justify-center p-8 text-destructive">
          <p className="font-bold">An error occurred rendering this component:</p>
          <pre className="mt-2 rounded bg-muted p-4 text-xs font-mono">{this.state.error.toString()}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const withSuspense = (Component: React.ComponentType, isFullPage = false) => (
  <ErrorBoundary>
    <Suspense fallback={<div role="status" aria-busy="true" className={`flex items-center justify-center ${isFullPage ? 'h-screen' : 'h-full w-full'}`} />}>
      <Component />
    </Suspense>
  </ErrorBoundary>
);

const router = createBrowserRouter([
  {
    path: '/',
    element: withSuspense(LandingPage, true),
  },
  {
    path: '/login',
    element: withSuspense(LoginPage, true),
  },
  {
    element: <AppShell />,
    children: [
      { path: 'dashboard', element: withSuspense(DashboardPage) },
      { path: 'jobs', element: withSuspense(JobsPage) },
      { path: 'jobs/:id', element: withSuspense(JobDetailPage) },
      { path: 'jobs/:id/logs', element: withSuspense(JobLogsPage) },
      { path: 'repos', element: withSuspense(ReposPage) },
      { path: 'repos/add/bitbucket', element: withSuspense(AddBitbucketRepoPage) },
      { path: 'repos/add/bitbucket-workspace', element: withSuspense(AddBitbucketWorkspacePage) },
      { path: 'stats', element: withSuspense(StatsPage) },
      { path: 'credentials', element: withSuspense(VcsCredentialsPage) },
      { path: 'settings', element: withSuspense(SettingsPage) },
    ],
  },
  {
    path: '*',
    element: withSuspense(NotFoundPage, true),
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <SmoothScroll root lerp={0.16} duration={0.9}>
        <RouterProvider router={router} />
        <ToasterWrapper />
      </SmoothScroll>
    </ThemeProvider>
  </React.StrictMode>,
);
