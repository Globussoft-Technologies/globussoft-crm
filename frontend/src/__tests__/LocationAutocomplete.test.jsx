/**
 * LocationAutocomplete.jsx — type-ahead location suggestions for
 * itinerary/destination text fields (drop-in replacement for a plain
 * <input>, backed by lib/geocoder.js's Photon-proxy geocodeSuggestions()).
 *
 * Cases:
 *   - Renders as a plain controlled input; typing calls onChange(text)
 *     synchronously like a native input (no debounce on the value itself)
 *   - Below MIN_CHARS (2), no suggestion fetch fires
 *   - At/above MIN_CHARS, debounces before fetching suggestions
 *   - Shows "Searching…" while the fetch is in flight
 *   - Renders a row per suggestion after the fetch resolves
 *   - Clicking a row fires onChange(display_name) + onSelect(suggestion)
 *     and closes the dropdown
 *   - ArrowDown/ArrowUp move the highlighted row; Enter selects it
 *   - Escape closes the dropdown without changing the value
 *   - Stale (out-of-order) responses are dropped
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const geocodeSuggestionsMock = vi.fn();
vi.mock("../lib/geocoder", () => ({
  geocodeSuggestions: (...args) => geocodeSuggestionsMock(...args),
  geocodeSuggest: (...args) => geocodeSuggestionsMock(...args),
}));

import LocationAutocomplete from "../components/travel/LocationAutocomplete";

const SUGGESTIONS = [
  { lat: 15.2993, lng: 74.124, display_name: "Goa, India" },
  { lat: 40.4168, lng: -3.7038, display_name: "Madrid, Spain" },
];

function Harness(props) {
  const [value, setValue] = useState(props.initialValue || "");
  return (
    <LocationAutocomplete
      value={value}
      onChange={(text) => {
        setValue(text);
        props.onChange?.(text);
      }}
      onSelect={props.onSelect}
    />
  );
}

beforeEach(() => {
  geocodeSuggestionsMock.mockReset().mockResolvedValue(SUGGESTIONS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("LocationAutocomplete", () => {
  it("behaves like a plain controlled input on typing", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "G" } });
    expect(onChange).toHaveBeenCalledWith("G");
    expect(input.value).toBe("G");
  });

  it("does not fetch suggestions below the minimum character count", async () => {
    vi.useFakeTimers();
    render(<Harness />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "G" } });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(geocodeSuggestionsMock).not.toHaveBeenCalled();
  });

  it("debounces and fetches suggestions once at/above the minimum length", async () => {
    vi.useFakeTimers();
    render(<Harness />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Go" } });
    fireEvent.change(input, { target: { value: "Goa" } });
    expect(geocodeSuggestionsMock).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(geocodeSuggestionsMock).toHaveBeenCalledTimes(1);
    expect(geocodeSuggestionsMock).toHaveBeenCalledWith("Goa", 6);
  });

  it("renders suggestion rows after the fetch resolves", async () => {
    render(<Harness initialValue="Go" />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Goa" } });
    fireEvent.focus(input);

    await waitFor(() => {
      expect(screen.getByTestId("location-autocomplete-row-0")).toHaveTextContent("Goa, India");
    });
    expect(screen.getByTestId("location-autocomplete-row-1")).toHaveTextContent("Madrid, Spain");
  });

  it("selecting a row fires onChange + onSelect and closes the dropdown", async () => {
    const onChange = vi.fn();
    const onSelect = vi.fn();
    render(<Harness onChange={onChange} onSelect={onSelect} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Goa" } });
    fireEvent.focus(input);

    const row = await screen.findByTestId("location-autocomplete-row-0");
    fireEvent.mouseDown(row);

    expect(onChange).toHaveBeenCalledWith("Goa, India");
    expect(onSelect).toHaveBeenCalledWith(SUGGESTIONS[0]);
    expect(screen.queryByTestId("location-autocomplete-listbox")).not.toBeInTheDocument();
  });

  it("ArrowDown highlights a row and Enter selects it", async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Goa" } });
    fireEvent.focus(input);

    await screen.findByTestId("location-autocomplete-row-0");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith(SUGGESTIONS[0]);
  });

  it("Escape closes the dropdown", async () => {
    render(<Harness />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Goa" } });
    fireEvent.focus(input);

    await screen.findByTestId("location-autocomplete-listbox");
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByTestId("location-autocomplete-listbox")).not.toBeInTheDocument();
  });

  it("drops a stale response that resolves after a newer request", async () => {
    let resolveFirst;
    geocodeSuggestionsMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(() => Promise.resolve([{ lat: 1, lng: 1, display_name: "Second, Result" }]));

    vi.useFakeTimers();
    render(<Harness />);
    const input = screen.getByRole("combobox");

    fireEvent.change(input, { target: { value: "Fir" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.change(input, { target: { value: "Sec" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    vi.useRealTimers();
    await waitFor(() => {
      expect(screen.getByTestId("location-autocomplete-row-0")).toHaveTextContent("Second, Result");
    });

    // Now resolve the stale first request — it must not clobber the list.
    await act(async () => {
      resolveFirst([{ lat: 9, lng: 9, display_name: "Stale, Result" }]);
    });
    expect(screen.getByTestId("location-autocomplete-row-0")).toHaveTextContent("Second, Result");
  });
});
