import { useContext } from "react";
import { useLocation } from "react-router-dom";
import RoleGuard from "./RoleGuard";
import { AuthContext } from "../appContexts";
import {
  genericRoleGuardProps,
  getGenericAccessForLocation,
} from "../utils/sidebarSearch";

export default function GenericAccessGuard({ path, children, message }) {
  const location = useLocation();
  const { tenant } = useContext(AuthContext);
  if (!path && tenant?.vertical && tenant.vertical !== "generic") return children;
  const resolvedPath = path || getGenericAccessForLocation(location.pathname)?.path;
  const guard = genericRoleGuardProps(resolvedPath);
  // /dashboard itself requires reports.read. RoleGuard's general fallback is
  // also /dashboard, which traps users without that grant on the denied URL
  // with an empty page. /home is the permission-aware landing surface for
  // those users, so use it only for this route.
  const redirectTo = resolvedPath === "/dashboard" ? "/home" : undefined;
  if (!guard.allow && !guard.requiredPermission) return children;
  // A permission grant is authoritative. Applying the legacy role allow-list
  // as a second check would reject a correctly configured custom role solely
  // because its legacy User.role is not ADMIN or MANAGER.
  if (guard.requiredPermission) {
    return (
      <RoleGuard requiredPermission={guard.requiredPermission} message={message} redirectTo={redirectTo}>
        {children}
      </RoleGuard>
    );
  }
  return (
    <RoleGuard {...guard} message={message} redirectTo={redirectTo}>
      {children}
    </RoleGuard>
  );
}
