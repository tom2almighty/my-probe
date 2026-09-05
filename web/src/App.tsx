import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "@/components/layout";
import LoginPage from "@/pages/login";
import PublicPage from "@/pages/public";
import PublicServerPage from "@/pages/public-server";
import DashboardPage from "@/pages/dashboard";
import ServersPage from "@/pages/servers";
import ServerDetailPage from "@/pages/server-detail";
import ProbesPage from "@/pages/probes";
import AlertsPage from "@/pages/alerts";
import { getToken } from "@/lib/api";

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!getToken()) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      {/* 公开状态页：不登录即可访问，后台入口在页面右上角 */}
      <Route path="/" element={<PublicPage />} />
      {/* 公开节点详情：历史曲线 + 本机到各目标的延迟 */}
      <Route path="/s/:id" element={<PublicServerPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/overview" element={<DashboardPage />} />
        <Route path="/servers" element={<ServersPage />} />
        <Route path="/servers/:id" element={<ServerDetailPage />} />
        <Route path="/probes" element={<ProbesPage />} />
        <Route path="/alerts" element={<AlertsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
