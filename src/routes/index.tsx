import { useParams } from 'react-router-dom';
import { createBrowserRouter } from 'react-router-dom';
import HomePage         from '@/pages/Home/index';
import NotFoundPage     from '@/pages/NotFound/index';
import Layout           from '@/components/Layout';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import ZeroDteCockpit   from '@/cockpits/ZeroDteCockpit';
import ChainCockpit     from '@/cockpits/ChainCockpit';
import BestContractsCockpit from '@/cockpits/BestContractsCockpit';
import InsidersCockpit  from '@/cockpits/InsidersCockpit';
import NewsCockpit      from '@/cockpits/NewsCockpit';
import BrainCockpit     from '@/cockpits/BrainCockpit';
import SwingCockpit     from '@/cockpits/SwingCockpit';
import IndexesCockpit   from '@/cockpits/IndexesCockpit';
import { HeliosChart }  from '@/components/HeliosChart';

// Deep-link-only helper — resolves :ticker from the URL for /chart/:ticker.
// Not used by the shell's normal chart navigation (which passes a ref directly).
function ChartDeepLink() {
  const { ticker } = useParams<{ ticker: string }>();
  return (
    <section id="chart">
      <HeliosChart ticker={(ticker ?? 'SPY').toUpperCase()} />
    </section>
  );
}

// The shell (HomePage) is the primary navigation layer for all cockpits.
// Only routes that need a direct deep-link URL are listed here.
// DashboardCockpit, ScannerCockpit, etc. are accessed via the shell's bottom nav.

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { path: '/',              element: <HomePage /> },
      // Deep links — for sharing specific views directly
      { path: '/chain',         element: <ErrorBoundary label="Chain"><ChainCockpit /></ErrorBoundary> },
      { path: '/zerod',         element: <ErrorBoundary label="0DTE"><ZeroDteCockpit /></ErrorBoundary> },
      { path: '/zerod/:ticker', element: <ErrorBoundary label="0DTE"><ZeroDteCockpit /></ErrorBoundary> },
      // Additive direct links — same components already used in the bottom-nav shell.
      // Reachable by URL only; existing tab-based navigation is untouched.
      { path: '/best',     element: <ErrorBoundary label="Best Contracts"><section id="best"><BestContractsCockpit /></section></ErrorBoundary> },
      { path: '/insiders', element: <ErrorBoundary label="Insiders"><section id="insiders"><InsidersCockpit /></section></ErrorBoundary> },
      { path: '/news',     element: <ErrorBoundary label="News"><section id="news"><NewsCockpit /></section></ErrorBoundary> },
      { path: '/brain',    element: <ErrorBoundary label="Brain"><section id="brain"><BrainCockpit /></section></ErrorBoundary> },
      { path: '/swing',    element: <ErrorBoundary label="Swing"><section id="swing"><SwingCockpit /></section></ErrorBoundary> },
      { path: '/indexes',  element: <ErrorBoundary label="Indexes"><section id="indexes"><IndexesCockpit /></section></ErrorBoundary> },
      { path: '/chart',         element: <ErrorBoundary label="Chart"><section id="chart"><HeliosChart ticker="SPY" /></section></ErrorBoundary> },
      { path: '/chart/:ticker', element: <ErrorBoundary label="Chart"><ChartDeepLink /></ErrorBoundary> },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]);
