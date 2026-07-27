import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import GitHubCatIcon from '../components/GitHubCatIcon';

describe('<GitHubCatIcon />', () => {
  it('renders a GitHub link with tooltip text', () => {
    render(<GitHubCatIcon C={{ text: '#111111' }} />);

    const link = screen.getByRole('link', { name: /view globus crm on github/i });
    expect(link).toHaveAttribute('href', 'https://github.com/Globussoft-Technologies/globussoft-crm.git');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Globus CRM GitHub Code');
  });
});
