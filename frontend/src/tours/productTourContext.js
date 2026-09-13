import { createContext } from "react";
import { DEFAULT_TOUR_PREFERENCES } from "./tourStorage";

export const EMPTY_PRODUCT_TOUR_CONTEXT = Object.freeze({
  isAvailable: false,
  effectiveEnabled: false,
  organizationEnabled: true,
  canManageOrganization: false,
  preferences: DEFAULT_TOUR_PREFERENCES,
  progress: {},
  currentFeature: null,
  availableTours: [],
  activeTour: null,
  startTour: () => false,
  startCurrentTour: () => false,
  closeTour: () => {},
  skipTour: () => {},
  skipAllTours: () => {},
  setPreferences: () => {},
  setOrganizationEnabled: async () => false,
  restartAllTours: () => {},
});

export const ProductTourContext = createContext(EMPTY_PRODUCT_TOUR_CONTEXT);
