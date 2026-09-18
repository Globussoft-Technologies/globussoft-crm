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
  if (!guard.allow && !guard.requiredPermission) return children;
  if (guard.allow && guard.requiredPermission) {
    return (
      <RoleGuard allow={guard.allow} message={message}>
        <RoleGuard requiredPermission={guard.requiredPermission} message={message}>
          {children}
        </RoleGuard>
      </RoleGuard>
    );
  }
  return (
    <RoleGuard {...guard} message={message}>
      {children}
    </RoleGuard>
  );
}
