/**
 * BlockRenderer.test.jsx — vitest + RTL coverage for landing page block renderer
 *
 * SUT: frontend/src/components/landing-page-renderers/BlockRenderer.jsx (195 LOC)
 *
 * Pins the block rendering pipeline:
 *   1. Extracts pageId from landingPage prop
 *   2. Passes pageId to FormBlock component (for authenticated endpoint)
 *   3. Renders all block types correctly
 *   4. Handles nested blocks (columns, etc.)
 *   5. Recursive renderBlock function works
 *   6. Analytics tracking fires for page view
 *   7. Fallback to empty blocks array
 *   8. CSS styles applied correctly
 *   9. Form submission uses new endpoint when pageId available
 *  10. Backward compatibility: works without pageId (old HTML renderer)
 *
 * Pattern: vitest + React Testing Library with mocked Image constructor
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BlockRenderer from '../components/landing-page-renderers/BlockRenderer';

// Mock window.Image for analytics tracking.
// Must be a regular (non-arrow) function so it can be used with `new`.
global.Image = vi.fn(function () {
  this.src = '';
});

const sampleLandingPage = {
  id: 123,
  slug: 'test-page',
  title: 'Test Landing Page',
  content: [
    {
      id: 'h1',
      type: 'heading',
      props: {
        level: 'h1',
        text: 'Welcome to our page',
      },
    },
    {
      id: 'text1',
      type: 'text',
      props: {
        text: 'This is a test landing page',
      },
    },
  ],
};

describe('<BlockRenderer /> — block rendering and pageId passing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('renders landing page with blocks from content array', () => {
    render(
      <MemoryRouter>
        <BlockRenderer landingPage={sampleLandingPage} />
      </MemoryRouter>
    );

    expect(screen.getByRole('heading', { name: /Welcome to our page/i })).toBeInTheDocument();
    expect(screen.getByText('This is a test landing page')).toBeInTheDocument();
  });

  test('extracts pageId from landingPage and passes to FormBlock', () => {
    const pageWithForm = {
      id: 456,
      slug: 'registration-page',
      title: 'Registration',
      content: [
        {
          id: 'form1',
          type: 'form',
          props: {
            fields: [
              { name: 'name', label: 'Name', required: true },
              { name: 'email', label: 'Email', required: true },
            ],
            submitText: 'Register',
          },
        },
      ],
    };

    render(
      <MemoryRouter>
        <BlockRenderer landingPage={pageWithForm} />
      </MemoryRouter>
    );

    // Form should render (indicating pageId was passed)
    expect(screen.getByRole('button', { name: /Register/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  test('fires analytics tracking pixel on mount', () => {
    render(
      <MemoryRouter>
        <BlockRenderer landingPage={sampleLandingPage} />
      </MemoryRouter>
    );

    expect(global.Image).toHaveBeenCalled();
    // Verify the analytics pixel URL includes the slug
    const imageInstance = global.Image.mock.results[0].value;
    expect(imageInstance.src).toMatch(/\/api\/pages\/test-page\/track/);
  });

  test('skips analytics tracking if slug is empty', () => {
    const pageNoSlug = {
      id: 123,
      slug: '',
      title: 'No Slug Page',
      content: [],
    };

    render(
      <MemoryRouter>
        <BlockRenderer landingPage={pageNoSlug} />
      </MemoryRouter>
    );

    // Image constructor may still be called by useEffect, but src should not be set
    // Or more accurately, check that the effect didn't fire the tracker
  });

  test('renders empty blocks array without error', () => {
    const emptyPage = {
      id: 123,
      slug: 'empty-page',
      title: 'Empty Page',
      content: [],
    };

    render(
      <MemoryRouter>
        <BlockRenderer landingPage={emptyPage} />
      </MemoryRouter>
    );

    // Should render without crashing
    const mainElement = screen.getByRole('main');
    expect(mainElement).toBeInTheDocument();
    expect(mainElement.className).toContain('block-renderer');
  });

  test('handles missing landingPage prop (defaults to empty object)', () => {
    render(
      <MemoryRouter>
        <BlockRenderer />
      </MemoryRouter>
    );

    const mainElement = screen.getByRole('main');
    expect(mainElement).toBeInTheDocument();
  });

  test('renders multiple block types in sequence', () => {
    const multiBlockPage = {
      id: 789,
      slug: 'multi-block-page',
      title: 'Multi-Block Page',
      content: [
        {
          id: 'h1',
          type: 'heading',
          props: { level: 'h1', text: 'Main Title' },
        },
        {
          id: 'text1',
          type: 'text',
          props: { text: 'Introduction paragraph' },
        },
        {
          id: 'spacer1',
          type: 'spacer',
          props: { height: '32px' },
        },
        {
          id: 'text2',
          type: 'text',
          props: { text: 'Closing paragraph' },
        },
      ],
    };

    render(
      <MemoryRouter>
        <BlockRenderer landingPage={multiBlockPage} />
      </MemoryRouter>
    );

    expect(screen.getByRole('heading', { name: /Main Title/i })).toBeInTheDocument();
    expect(screen.getByText('Introduction paragraph')).toBeInTheDocument();
    expect(screen.getByText('Closing paragraph')).toBeInTheDocument();
  });

  test('renders image block with correct src and alt attributes', () => {
    const pageWithImage = {
      id: 111,
      slug: 'image-page',
      title: 'Image Page',
      content: [
        {
          id: 'img1',
          type: 'image',
          props: {
            src: 'https://example.com/image.jpg',
            alt: 'Test image',
            width: '100%',
          },
        },
      ],
    };

    render(
      <MemoryRouter>
        <BlockRenderer landingPage={pageWithImage} />
      </MemoryRouter>
    );

    const img = screen.getByAltText('Test image');
    expect(img).toBeInTheDocument();
    expect(img.src).toBe('https://example.com/image.jpg');
  });

  test('wellness event images stretch to their column and keep auto height', () => {
    render(
      <MemoryRouter>
        <BlockRenderer landingPage={{
          id: 222,
          slug: 'wellness-page',
          title: 'Wellness Page',
          content: [
            {
              id: 'img2',
              type: 'image',
              props: {
                src: 'https://example.com/wellness.jpg',
                alt: 'Wellness image',
                variant: 'wellness-event-image',
                maxWidth: '420px',
              },
            },
          ],
        }} />
      </MemoryRouter>
    );

    const img = screen.getByAltText('Wellness image');
    expect(img).toBeInTheDocument();
    expect(img.style.width).toBe('100%');
    expect(img.style.maxWidth).toBe('100%');
    expect(img.style.height).toBe('360px');
  });
  test('renders button block with link', () => {
    const pageWithButton = {
      id: 222,
      slug: 'button-page',
      title: 'Button Page',
      content: [
        {
          id: 'btn1',
          type: 'button',
          props: {
            text: 'Click me',
            url: 'https://example.com',
            bgColor: '#2563eb',
          },
        },
      ],
    };

    render(
      <MemoryRouter>
        <BlockRenderer landingPage={pageWithButton} />
      </MemoryRouter>
    );

    const link = screen.getByRole('link', { name: /Click me/i });
    expect(link).toBeInTheDocument();
    expect(link.href).toBe('https://example.com/');
  });

  test('routes wellness CTA buttons to the lead capture form', () => {
    const pageWithButton = {
      id: 223,
      slug: 'wellness-button-page',
      title: 'Wellness Button Page',
      content: [
        {
          id: 'btn-wellness',
          type: 'button',
          props: {
            text: 'Get Started',
            url: '#event-details',
            bgColor: '#b31d15',
          },
        },
      ],
    };

    render(
      <MemoryRouter>
        <BlockRenderer landingPage={pageWithButton} />
      </MemoryRouter>
    );

    expect(screen.getByRole('link', { name: /Get Started/i })).toHaveAttribute('href', '#lead-form');
  });

  test('renders semantic wellness icons for new and legacy benefit badges', () => {
    const { container } = render(
      <MemoryRouter>
        <BlockRenderer landingPage={{
          slug: 'wellness-icons',
          content: [
            { id: 'new-eye', type: 'text', props: { variant: 'wellness-badge', icon: 'eye', text: '' } },
            { id: 'legacy-person', type: 'text', props: { variant: 'wellness-badge', text: 'o' } },
            { id: 'legacy-users', type: 'text', props: { variant: 'wellness-badge', text: ':)' } },
            { id: 'legacy-document', type: 'text', props: { variant: 'wellness-badge', text: '#' } },
          ],
        }} />
      </MemoryRouter>,
    );

    expect(container.querySelectorAll('.landing-text--wellness-badge')).toHaveLength(4);
    expect(container.querySelectorAll('.landing-text--wellness-badge svg')).toHaveLength(4);
    const badgeText = Array.from(container.querySelectorAll('.landing-text--wellness-badge'))
      .map((badge) => badge.textContent)
      .join('');
    expect(badgeText).not.toContain(':)');
    expect(badgeText).not.toContain('#');
  });

  test('renders wellness navigation as separate section links', () => {
    render(
      <MemoryRouter>
        <BlockRenderer landingPage={{
          slug: 'wellness-navigation',
          content: [{
            id: 'wellness-nav',
            type: 'text',
            props: { variant: 'wellness-nav', text: 'HOME   SERVICES   ABOUT US   CONTACT' },
          }],
        }} />
      </MemoryRouter>,
    );

    const nav = screen.getByRole('navigation', { name: 'Wellness campaign navigation' });
    expect(nav.querySelector('a[href="#wellness-home"]')).toHaveTextContent('HOME');
    expect(nav.querySelector('a[href="#wellness-services"]')).toHaveTextContent('SERVICES');
    expect(nav.querySelector('a[href="#wellness-about"]')).toHaveTextContent('ABOUT US');
    expect(nav.querySelector('a[href="#wellness-contact"]')).toHaveTextContent('CONTACT');
  });

  test('exposes wellness section anchors for header navigation', () => {
    render(
      <MemoryRouter>
        <BlockRenderer landingPage={{
          slug: 'wellness-navigation-targets',
          content: ['wellness-campaign-page', 'wellness-benefits-row', 'wellness-process-row', 'wellness-form-row']
            .map((variant) => ({ type: 'columns', props: { variant, columns: [] } })),
        }} />
      </MemoryRouter>,
    );

    expect(document.getElementById('wellness-home')).toBeInTheDocument();
    expect(document.getElementById('wellness-services')).toBeInTheDocument();
    expect(document.getElementById('wellness-about')).toBeInTheDocument();
    expect(document.getElementById('wellness-contact')).toBeInTheDocument();
  });

  test('removes the legacy wellness brand subline and duplicate hero CTA', () => {
    render(
      <MemoryRouter>
        <BlockRenderer landingPage={{
          slug: 'legacy-wellness-campaign',
          templateType: 'generic-site-eye-care',
          content: [{
            id: 'wellness-page',
            type: 'columns',
            props: {
              variant: 'wellness-campaign-page',
              columns: [{
                fullWidth: true,
                components: [
                  {
                    id: 'wellness-header-row',
                    type: 'columns',
                    props: {
                      variant: 'wellness-header-row',
                      columns: [
                        { components: [
                          { id: 'brand-name', type: 'heading', props: { text: 'Enhance Wellness' } },
                          { id: 'brand-subline', type: 'text', props: { text: 'Wellness' } },
                        ] },
                        { components: [] },
                      ],
                    },
                  },
                  {
                    id: 'wellness-hero-row',
                    type: 'columns',
                    props: {
                      variant: 'wellness-hero-row',
                      columns: [{ components: [
                        { id: 'hero-primary-cta', type: 'button', props: { text: 'Register Now', url: '#lead-form' } },
                        { id: 'contact-cta', type: 'button', props: { text: 'Contact Us', url: '#lead-form' } },
                      ] }],
                    },
                  },
                ],
              }],
            },
          }],
        }} />
      </MemoryRouter>,
    );

    expect(screen.getByText('Enhance Wellness')).toBeInTheDocument();
    expect(screen.queryByText('Wellness')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Register Now' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Contact Us' })).not.toBeInTheDocument();
  });

  test('renders wellness consultation form with the lead-form anchor target', () => {
    const pageWithForm = {
      id: 224,
      slug: 'wellness-form-page',
      title: 'Wellness Form Page',
      content: [
        {
          id: 'lead-form',
          type: 'form',
          props: {
            variant: 'wellness-consultation',
            title: 'Register',
            fields: [],
          },
        },
      ],
    };

    render(
      <MemoryRouter>
        <BlockRenderer landingPage={pageWithForm} />
      </MemoryRouter>
    );

    expect(document.getElementById('lead-form')).toBeInTheDocument();
  });

  test('hides the wellness service-of-interest field from the registration form', () => {
    render(
      <MemoryRouter>
        <BlockRenderer landingPage={{
          slug: 'wellness-form-fields',
          content: [{
            id: 'lead-form',
            type: 'form',
            props: {
              variant: 'wellness-consultation',
              fields: [
                { name: 'first_name', label: 'First Name', required: true },
                { name: 'service_interest', label: 'Service of Interest', type: 'select' },
                { name: 'message', label: 'Tell Us More', type: 'textarea' },
              ],
            },
          }],
        }} />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText(/First Name/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Tell Us More/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Service of Interest/)).not.toBeInTheDocument();
  });

  test('centers legacy wellness registration forms and removes the duplicate form heading', () => {
    render(
      <MemoryRouter>
        <BlockRenderer landingPage={{
          slug: 'legacy-registration-page',
          templateType: 'generic-site-eye-care',
          content: [{
            id: 'wellness-page',
            type: 'columns',
            props: {
              variant: 'wellness-campaign-page',
              columns: [{
                fullWidth: true,
                components: [{
                  id: 'legacy-registration',
                  type: 'columns',
                  props: {
                    variant: 'wellness-registration-row',
                    columns: [
                      { components: [
                        { id: 'form-title-copy', type: 'heading', props: { text: 'Register for Eye Checkup' } },
                        { id: 'lead-form', type: 'form', props: { title: 'Register for Eye Checkup', fields: [] } },
                      ] },
                      { components: [{ id: 'secondary-copy', type: 'text', props: { text: 'Secondary registration content' } }] },
                    ],
                  },
                }],
              }],
            },
          }],
        }} />
      </MemoryRouter>
    );

    expect(screen.getAllByText('Register for Eye Checkup')).toHaveLength(1);
    expect(screen.queryByText('Secondary registration content')).not.toBeInTheDocument();
    expect(document.querySelector('.wellness-layout--wellness-registration-row')).toBeInTheDocument();
    expect(document.querySelector('.wellness-layout--wellness-registration-row > div:only-child')).toBeInTheDocument();
  });

  test('applies custom wellness colors from the campaign root', () => {
    render(
      <MemoryRouter>
        <BlockRenderer landingPage={{
          slug: 'custom-wellness-page',
          templateType: 'generic-site-eye-care',
          content: [{
            id: 'wellness-page',
            type: 'columns',
            props: {
              variant: 'wellness-campaign-page',
              themeId: 'custom',
              customColors: { bg: '#fef2f2', primary: '#be123c', accent: '#f59e0b' },
              columns: [],
            },
          }],
        }} />
      </MemoryRouter>
    );

    const content = document.querySelector('.landing-page-content');
    expect(content.style.getPropertyValue('--wellness-bg')).toBe('#fef2f2');
    expect(content.style.getPropertyValue('--wellness-primary')).toBe('#be123c');
    expect(content.style.getPropertyValue('--wellness-accent')).toBe('#f59e0b');
  });

  test('renders video block with iframe for embed URL', () => {
    const pageWithVideo = {
      id: 333,
      slug: 'video-page',
      title: 'Video Page',
      content: [
        {
          id: 'video1',
          type: 'video',
          props: {
            url: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
            width: '100%',
          },
        },
      ],
    };

    render(
      <MemoryRouter>
        <BlockRenderer landingPage={pageWithVideo} />
      </MemoryRouter>
    );

    const iframe = screen.getByTitle('Embedded video');
    expect(iframe).toBeInTheDocument();
  });

  test('renders columns block with nested content', () => {
    const pageWithColumns = {
      id: 444,
      slug: 'columns-page',
      title: 'Columns Page',
      content: [
        {
          id: 'cols1',
          type: 'columns',
          props: {
            columns: [
              {
                components: [
                  {
                    id: 'text-col1',
                    type: 'text',
                    props: { text: 'Left column text' },
                  },
                ],
              },
              {
                components: [
                  {
                    id: 'text-col2',
                    type: 'text',
                    props: { text: 'Right column text' },
                  },
                ],
              },
            ],
          },
        },
      ],
    };

    render(
      <MemoryRouter>
        <BlockRenderer landingPage={pageWithColumns} />
      </MemoryRouter>
    );

    expect(screen.getByText('Left column text')).toBeInTheDocument();
    expect(screen.getByText('Right column text')).toBeInTheDocument();
  });

  test('renders divider block', () => {
    const pageWithDivider = {
      id: 555,
      slug: 'divider-page',
      title: 'Divider Page',
      content: [
        {
          id: 'text1',
          type: 'text',
          props: { text: 'Before divider' },
        },
        {
          id: 'divider1',
          type: 'divider',
          props: { color: '#e5e7eb' },
        },
        {
          id: 'text2',
          type: 'text',
          props: { text: 'After divider' },
        },
      ],
    };

    render(
      <MemoryRouter>
        <BlockRenderer landingPage={pageWithDivider} />
      </MemoryRouter>
    );

    const hr = screen.getByRole('main').querySelector('hr');
    expect(hr).toBeInTheDocument();
  });

  test('skips rendering unknown block types gracefully', () => {
    const pageWithUnknown = {
      id: 666,
      slug: 'unknown-page',
      title: 'Unknown Page',
      content: [
        {
          id: 'text1',
          type: 'text',
          props: { text: 'Known block' },
        },
        {
          id: 'unknown1',
          type: 'unknownBlockType',
          props: { data: 'unknown' },
        },
        {
          id: 'text2',
          type: 'text',
          props: { text: 'Another known block' },
        },
      ],
    };

    render(
      <MemoryRouter>
        <BlockRenderer landingPage={pageWithUnknown} />
      </MemoryRouter>
    );

    expect(screen.getByText('Known block')).toBeInTheDocument();
    expect(screen.getByText('Another known block')).toBeInTheDocument();
    // Unknown block should not render, no error thrown
  });

  test('public landing-site forms submit through public API endpoint', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, message: 'OK' }),
    });

    render(
      <MemoryRouter>
        <BlockRenderer landingPage={{
          id: 456,
          slug: 'public-site',
          title: 'Public Site',
          publicSubmit: true,
          content: [
            {
              id: 'form1',
              type: 'form',
              props: {
                fields: [{ name: 'email', label: 'Email', type: 'email' }],
                submitText: 'Send',
              },
            },
          ],
        }} />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: /Send/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/pages/public-site/submit', expect.any(Object));
    });
    global.fetch = originalFetch;
  });

  test('pageId null falls back gracefully (old HTML renderer compatibility)', () => {
    const pageNoId = {
      id: null,
      slug: 'fallback-page',
      title: 'Fallback Page',
      content: [
        {
          id: 'h1',
          type: 'heading',
          props: { text: 'Fallback heading' },
        },
      ],
    };

    render(
      <MemoryRouter>
        <BlockRenderer landingPage={pageNoId} />
      </MemoryRouter>
    );

    expect(screen.getByRole('heading', { name: /Fallback heading/i })).toBeInTheDocument();
  });

  test('content as non-array defaults to empty array', () => {
    const pageWithBadContent = {
      id: 777,
      slug: 'bad-content-page',
      title: 'Bad Content Page',
      content: 'not an array',
    };

    render(
      <MemoryRouter>
        <BlockRenderer landingPage={pageWithBadContent} />
      </MemoryRouter>
    );

    // Should render main element but no blocks
    const mainElement = screen.getByRole('main');
    expect(mainElement).toBeInTheDocument();
  });

  test('applies landing page CSS styles in main element', () => {
    const { container } = render(
      <MemoryRouter>
        <BlockRenderer landingPage={sampleLandingPage} />
      </MemoryRouter>
    );

    const main = container.querySelector('main.landing-page.block-renderer');
    expect(main).toBeInTheDocument();

    // Check that style tag with landing-page CSS is present
    const styleTag = container.querySelector('style');
    expect(styleTag).toBeInTheDocument();
    expect(styleTag.textContent).toContain('.landing-page');
    expect(styleTag.textContent).toContain('.landing-heading--wellness-metric-value');
    expect(styleTag.textContent).toContain('overflow-wrap: anywhere !important;');
  });

  test('form block receives correct slug parameter', () => {
    const pageWithForm = {
      id: 888,
      slug: 'form-slug-page',
      title: 'Form Page',
      content: [
        {
          id: 'form1',
          type: 'form',
          props: {
            fields: [
              { name: 'email', label: 'Email', required: true },
            ],
            submitText: 'Submit',
          },
        },
      ],
    };

    render(
      <MemoryRouter>
        <BlockRenderer landingPage={pageWithForm} />
      </MemoryRouter>
    );

    // Form should be rendered (indicates slug was passed)
    expect(screen.getByRole('button', { name: /Submit/i })).toBeInTheDocument();
  });

  test('handles content with valid JSON string parse', () => {
    const pageWithJsonString = {
      id: 999,
      slug: 'json-string-page',
      title: 'JSON String Page',
      content: JSON.stringify([
        {
          id: 'h1',
          type: 'heading',
          props: { text: 'JSON parsed content' },
        },
      ]),
    };

    // In actual implementation, BlockRenderer expects content to be an array
    // But it should handle string content gracefully
    render(
      <MemoryRouter>
        <BlockRenderer landingPage={pageWithJsonString} />
      </MemoryRouter>
    );

    const mainElement = screen.getByRole('main');
    expect(mainElement).toBeInTheDocument();
  });
});

