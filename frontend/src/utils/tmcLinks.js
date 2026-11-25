const TEACHER_REGISTRATION_PATH = "/tmc/register/teacher?tenantSlug=travel-stall&tmcRole=TEACHER&next=%2Ftmc%2Fteacher-portal";

export function getTeacherRegistrationLink() {
  if (typeof window === "undefined") return TEACHER_REGISTRATION_PATH;
  return `${window.location.origin}${TEACHER_REGISTRATION_PATH}`;
}
