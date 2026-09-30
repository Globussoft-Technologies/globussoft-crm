import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import CallifiedCallDetailsDrawer from "../components/CallifiedCallDetailsDrawer";

const fetchApiMock = vi.fn();
vi.mock("../utils/api", () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => "test-token",
}));

vi.mock("../utils/callified", () => ({
  crmRecordingUrl: (url) => url,
}));

describe("CallifiedCallDetailsDrawer", () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation((url) => {
      if (url === "/api/callified/calls/lead/11/latest") {
        return Promise.resolve({ callifiedLeadId: "456" });
      }
      if (url === "/api/callified/calls/456/details") {
        return Promise.resolve({
          transcripts: [{
            id: 789,
            created_at: "2026-09-28T09:06:00.000Z",
            call_duration_s: 175,
            transcript: [],
          }],
          reviews: [{
            transcript_id: 789,
            quality_score: 3,
            sentiment: "neutral",
            appointment_booked: false,
            call_outcome: "pending",
            summary: "The call requires follow-up.",
          }],
        });
      }
      if (url === "/api/callified/calls/lead/11/attempts") {
        return Promise.resolve({ attempts: [] });
      }
      return Promise.resolve({});
    });
  });

  it("shows Callified's pending outcome instead of treating it as no appointment", async () => {
    render(
      <CallifiedCallDetailsDrawer
        lead={{ id: 11, name: "Alice Smith" }}
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText("Pending")).toBeInTheDocument();
    expect(screen.queryByText("No appointment")).not.toBeInTheDocument();
  });
});
