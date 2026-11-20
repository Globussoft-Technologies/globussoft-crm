import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import CampaignRuleValue from '../components/CampaignRuleValue';
import { fetchApi } from '../utils/api';
vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));

it('finds matching values beyond the initial suggestions', async () => {
  fetchApi.mockImplementation(async url => ({values:[{value:url.includes('&q=partner') ? 'Partner event' : 'Organic'}]}));
  render(<CampaignRuleValue field="source" value="" onChange={vi.fn()}/>);
  const input = screen.getByRole('combobox');
  fireEvent.click(input);
  await screen.findByRole('option',{name:'Organic'});
  fireEvent.change(input,{target:{value:'partner'}});
  expect(await screen.findByRole('option',{name:'Partner event'})).toBeInTheDocument();
});

it('accepts typed text and offers existing values without saving on load', async () => {
  fetchApi.mockResolvedValue({ values: [{ value: 'website-form' }] });
  const onChange = vi.fn();
  render(<CampaignRuleValue field="source" value="" onChange={onChange} />);
  const input = screen.getByLabelText('Value to match');
  fireEvent.click(input);
  const option = await screen.findByRole('option', { name: 'website-form' });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(option);
  expect(onChange).toHaveBeenCalledWith('website-form');
  fireEvent.change(input, { target: { value: 'A new source' } });
  expect(onChange).toHaveBeenCalledWith('A new source');
});

it('filters as you type and closes through the arrow, outside clicks and selection', async () => {
  fetchApi.mockResolvedValue({ values: ['Website form','Embedded web form','Referral'].map(value=>({value})) });
  const onChange = vi.fn();
  render(<CampaignRuleValue field="source" value="" onChange={onChange}/>);
  const input = screen.getByRole('combobox');
  const arrow = screen.getByLabelText('Choose an existing match value');
  fireEvent.change(input,{target:{value:'WEB'}});
  expect(await screen.findByRole('option',{name:'Website form'})).toBeInTheDocument();
  expect(screen.queryByText('Referral')).toBeNull();
  fireEvent.click(arrow);
  expect(input).toHaveAttribute('aria-expanded','false');
  fireEvent.click(arrow);
  expect(screen.getByText('Referral')).toBeInTheDocument();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.click(input);
  fireEvent.keyDown(input,{key:'ArrowDown'});
  fireEvent.keyDown(input,{key:'Enter'});
  expect(onChange).toHaveBeenLastCalledWith('Website form');
  expect(screen.queryByRole('listbox')).toBeNull();
});
