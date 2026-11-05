import { Navigate, Route, Routes, useSearchParams } from "react-router";
import { PublicOnly, RequireAuth } from "./components/Layout";
import Login from "./pages/Login";
import { NotFound } from "./pages/Placeholder";
import { ForgotPassword, ResetPassword } from "./pages/PasswordReset";
import Profile from "./pages/profile/Profile";
import Register from "./pages/Register";
import PublicRun from "./pages/runs/PublicRun";
import RunsPage from "./pages/runs/RunsPage";
import RunView from "./pages/runs/RunView";
import TrashPage from "./pages/TrashPage";
import TemplateEditor from "./pages/templates/TemplateEditor";
import TemplatesPage from "./pages/templates/TemplatesPage";

/** Startseite: Rücksprung des SSO-Verknüpfens (`/?sso=linked`) führt ins Profil, sonst die Übersicht der aktiven Durchführungen. */
function Home() {
  const [params] = useSearchParams();
  if (params.get("sso") === "linked") return <Navigate to="/profile?sso=linked" replace />;
  return <RunsPage status="active" />;
}

export default function App() {
  return (
    <Routes>
      <Route element={<PublicOnly />}>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
      </Route>
      {/* Passwort zurücksetzen funktioniert auch mit bestehender Sitzung (E-Mail-Link) */}
      <Route path="/reset-password" element={<ResetPassword />} />
      {/* Öffentliche Ansicht eines Freigabelinks – ohne Anmeldung */}
      <Route path="/s/:token" element={<PublicRun />} />

      <Route element={<RequireAuth />}>
        <Route path="/" element={<Home />} />
        <Route path="/templates" element={<TemplatesPage />} />
        <Route path="/templates/:id" element={<TemplateEditor />} />
        <Route path="/runs/:id" element={<RunView />} />
        <Route path="/archive" element={<RunsPage status="archived" />} />
        <Route path="/trash" element={<TrashPage />} />
        <Route path="/profile" element={<Profile />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
