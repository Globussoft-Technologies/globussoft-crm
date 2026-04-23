import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LanguageSwitcher from '../components/LanguageSwitcher';

describe('LanguageSwitcher', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the current language (English by default)', () => {
    render(<LanguageSwitcher />);
    expect(screen.getByRole('button', { name: /english/i })).toBeInTheDocument();
  });

  it('clicking the button opens the dropdown with all supported languages', () => {
    render(<LanguageSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: /english/i }));
    // All three options are now visible
    expect(screen.getAllByRole('button').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(/हिन्दी/)).toBeInTheDocument();
    expect(screen.getByText(/Español/)).toBeInTheDocument();
  });

  it('selecting a language updates localStorage + triggers reload', () => {
    const reloadSpy = vi.fn();
    // jsdom requires a custom location mock for reload
    const originalLocation = window.location;
    delete window.location;
    window.location = { ...originalLocation, reload: reloadSpy };

    vi.useFakeTimers();
    render(<LanguageSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: /english/i }));
    fireEvent.click(screen.getByText(/हिन्दी/));
    expect(localStorage.getItem('language')).toBe('hi');
    // Reload is scheduled on a setTimeout — advance timers
    vi.advanceTimersByTime(150);
    expect(reloadSpy).toHaveBeenCalled();

    vi.useRealTimers();
    window.location = originalLocation;
  });

  it('clicking outside the dropdown closes it', () => {
    render(<LanguageSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: /english/i }));
    expect(screen.getByText(/हिन्दी/)).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    // Dropdown items should no longer be present
    expect(screen.queryByText(/हिन्दी/)).not.toBeInTheDocument();
  });

  it('unknown stored language falls back to the first supported language (en)', () => {
    localStorage.setItem('language', 'zz-unknown');
    render(<LanguageSwitcher />);
    // Button shows English since lang lookup fell back to SUPPORTED_LANGUAGES[0]
    expect(screen.getByRole('button', { name: /english/i })).toBeInTheDocument();
  });
});
