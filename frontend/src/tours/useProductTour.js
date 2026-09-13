import { useContext } from "react";
import { ProductTourContext } from "./productTourContext";

export function useProductTour() {
  return useContext(ProductTourContext);
}
