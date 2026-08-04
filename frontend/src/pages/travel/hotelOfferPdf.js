import {
  buildFlightOfferPdfBlob,
  FLIGHT_OFFER_PDF_WIDTH,
  FLIGHT_OFFER_PDF_HEIGHT,
} from "./flightOfferPdf";

export function buildHotelOfferPdfBlob(svgMarkup, options = {}) {
  return buildFlightOfferPdfBlob(svgMarkup, options);
}

export const HOTEL_OFFER_PDF_WIDTH = FLIGHT_OFFER_PDF_WIDTH;
export const HOTEL_OFFER_PDF_HEIGHT = FLIGHT_OFFER_PDF_HEIGHT;
