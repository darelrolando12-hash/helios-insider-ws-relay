import { createBrowserRouter } from 'react-router-dom';
import HomePage              from '@/pages/Home/index';
import NotFoundPage          from '@/pages/NotFound/index';
import Layout                from '@/components/Layout';
import ScannerCockpit        from '@/cockpits/ScannerCockpit';
import DashboardCockpit      from '@/cockpits/DashboardCockpit';
import ChainCockpit          from '@/cockpits/ChainCockpit';
import BestContractsCockpit  from '@/cockpits/BestContractsCockpit';
import ZeroDteCockpit        from '@/cockpits/ZeroDteCockpit';
import IndexesCockpit        from '@/cockpits/IndexesCockpit';
import SwingCockpit          from '@/cockpits/SwingCockpit';
import NewsCockpit           from '@/cockpits/NewsCockpit';
import InsidersCockpit       from '@/cockpits/InsidersCockpit';
import BrainCockpit          from '@/cockpits/BrainCockpit';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { path: '/',              element: <HomePage /> },
      { path: '/scanner',       element: <ScannerCockpit /> },
      { path: '/dashboard',     element: <DashboardCockpit /> },
      { path: '/chain',         element: <ChainCockpit /> },
      { path: '/best',          element: <BestContractsCockpit /> },
      { path: '/zerod',         element: <ZeroDteCockpit /> },
      { path: '/zerod/:ticker', element: <ZeroDteCockpit /> },
      { path: '/indexes',       element: <IndexesCockpit /> },
      { path: '/swing',         element: <SwingCockpit /> },
      { path: '/news',          element: <NewsCockpit /> },
      { path: '/insiders',      element: <InsidersCockpit /> },
      { path: '/brain',         element: <BrainCockpit /> },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]);

