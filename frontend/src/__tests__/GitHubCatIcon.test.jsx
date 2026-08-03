import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// lottie-react uses lottie-web which needs canvas; jsdom doesn't provide it.
vi.mock('lottie-react', () => ({
  __esModule: true,
  default: function Lottie({ animationData, style, autoplay, ...rest }) {
    return (
      <div data-testid="lottie-mock" data-animation={JSON.stringify(animationData)} data-autoplay={String(autoplay)} style={style} {...rest} />
    );
  },
}));

import GitHubCatIcon from '../components/GitHubCatIcon';

describe('<GitHubCatIcon />', () => {
  it('renders a GitHub link with tooltip text', () => {
    render(<GitHubCatIcon C={{ text: '#111111' }} />);

    const link = screen.getByRole('link', { name: /view globus crm on github/i });
    expect(link).toHaveAttribute('href', 'https://github.com/Globussoft-Technologies/globussoft-crm.git');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Globus CRM GitHub Code');
  });
});
