import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Card } from './components/Card';

const Dashboard = lazy(() => import('./pages/Dashboard').then(module => ({ default: module.Dashboard })));
const SymbolDetail = lazy(() => import('./pages/SymbolDetail').then(module => ({ default: module.SymbolDetail })));
const ActionableSetups = lazy(() => import('./pages/ActionableSetups').then(module => ({ default: module.ActionableSetups })));
const ActionableSetupDetail = lazy(() => import('./pages/ActionableSetupDetail').then(module => ({ default: module.ActionableSetupDetail })));
const TacticalWatch = lazy(() => import('./pages/TacticalWatch').then(module => ({ default: module.TacticalWatch })));
const TacticalDetail = lazy(() => import('./pages/TacticalDetail').then(module => ({ default: module.TacticalDetail })));
const Analytics = lazy(() => import('./pages/Analytics').then(module => ({ default: module.Analytics })));
const AlertsSettings = lazy(() => import('./pages/AlertsSettings').then(module => ({ default: module.AlertsSettings })));

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<RouteLoader><Dashboard /></RouteLoader>} />
        <Route path="/symbols/:symbol" element={<RouteLoader><SymbolDetail /></RouteLoader>} />
        <Route path="/setups" element={<RouteLoader><ActionableSetups /></RouteLoader>} />
        <Route path="/setups/:setupId" element={<RouteLoader><ActionableSetupDetail /></RouteLoader>} />
        <Route path="/tactical" element={<RouteLoader><TacticalWatch /></RouteLoader>} />
        <Route path="/tactical/:symbol" element={<RouteLoader><TacticalDetail /></RouteLoader>} />
        <Route path="/analytics" element={<RouteLoader><Analytics /></RouteLoader>} />
        <Route path="/alerts" element={<RouteLoader><AlertsSettings /></RouteLoader>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

function RouteLoader({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<Card>Loading dashboard module...</Card>}>
      {children}
    </Suspense>
  );
}
