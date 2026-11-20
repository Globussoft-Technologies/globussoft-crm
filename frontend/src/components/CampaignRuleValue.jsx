import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { fetchApi } from '../utils/api';

function loadValues(field, query = '') {
  const path = `/api/contacts/filter-values/${encodeURIComponent(field)}?status=Lead&ruleValues=1`;
  return fetchApi(query ? path + '&q=' + encodeURIComponent(query) : path, {silent:true})
    .then(result => (result?.values || []).filter(option => option.value != null && option.value !== '').map(option => String(option.value)));
}

export default function CampaignRuleValue({ field, value, disabled, onChange }) {
  const id = useId();
  const box = useRef(null), input = useRef(null), list = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState(null);
  const [options, setOptions] = useState(null);
  const [failed, setFailed] = useState(false);
  const [searchResult,setSearchResult] = useState(null);
  const expanded = open && Boolean(field) && !disabled;
  const search = query.trim();
  const candidates = new Set([...(options || []), ...(searchResult?.query === search ? searchResult.values : [])]);
  const matches = [...candidates].filter(option => option.toLowerCase().includes(search.toLowerCase()));
  const searchFinished = searchResult?.query === search;
  const unavailable = search ? searchFinished && searchResult.failed : failed;
  const loading = search ? !searchFinished : options === null;

  function show() {
    if (!open) { setQuery(''); setActive(-1); setOpen(true); }
  }
  function choose(option) {
    onChange(option);
    input.current?.focus();
    setOpen(false);
  }
  useEffect(() => {
    if (!expanded || options !== null) return;
    let current = true;
    setFailed(false);
    loadValues(field)
      .then(values => { if (current) setOptions(values); })
      .catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [field, expanded, options]);

  useEffect(() => {
    if (!expanded || !search) return;
    let current = true;
    const timer = setTimeout(() => {
      loadValues(field, search).then(values => {
        if (current) setSearchResult({query:search, values});
      }).catch(() => { if (current) setSearchResult({query:search, values:[], failed:true}); });
    }, 200);
    return () => { current=false; clearTimeout(timer); };
  }, [field, expanded, search]);

  useLayoutEffect(() => {
    if (!expanded) return;
    function place() {
      const rect = box.current.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 8;
      const above = below < 160 && rect.top > below;
      setPosition({ left: rect.left, width: rect.width, maxHeight: Math.max(0, Math.min(232, above ? rect.top - 8 : below)),
        ...(above ? {bottom:window.innerHeight - rect.top + 4} : {top:rect.bottom + 4}) });
    }
    function outside(event) {
      if (!box.current?.contains(event.target) && !list.current?.contains(event.target)) setOpen(false);
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
    };
  }, [expanded]);
  useEffect(() => {
    if (expanded && active >= 0) list.current?.children[active]?.scrollIntoView?.({block:'nearest'});
  }, [expanded, active]);

  return <div ref={box} className="campaign-rule-value">
    <input ref={input} className="input-field" type="text" role="combobox" aria-autocomplete="list" autoComplete="off"
      aria-label="Value to match" placeholder="Value to match" aria-expanded={expanded}
      aria-controls={expanded ? id : undefined} aria-activedescendant={expanded && active >= 0 ? id+'-'+active : undefined}
      value={value} disabled={disabled} onFocus={show} onClick={show}
      onChange={event => { show(); setQuery(event.target.value); setActive(-1); onChange(event.target.value); }}
      onKeyDown={event => {
        if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); show();
          setActive(index => matches.length ? (event.key === 'ArrowDown' ? Math.min(index+1,matches.length-1) : index<=0 ? matches.length-1 : index-1) : -1);
        } else if (event.key === 'Enter' && expanded) {
          event.preventDefault();
          if (matches[active] !== undefined) choose(matches[active]); else setOpen(false);
        } else if (event.key === 'Tab') setOpen(false);
      }}/>
    <button className="rule-value-arrow" type="button" tabIndex={-1} aria-label="Choose an existing match value"
      aria-expanded={expanded} disabled={disabled || !field} onMouseDown={event => event.preventDefault()}
      onClick={() => { if (expanded) setOpen(false); else { input.current?.focus(); show(); } }}><ChevronDown size={15}/></button>
    {expanded && position && createPortal(<div ref={list} id={id} role="listbox" aria-label="Existing match values"
      className="rule-value-options" style={position}>
      {matches.map((option,index) => <div key={option} id={id+'-'+index} role="option" aria-selected={option===value}
        data-active={index===active} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(option)}>{option}</div>)}
      {!matches.length && <small role="status">{unavailable ? 'Suggestions unavailable. You can still type a value.' : loading ? 'Loading values…' : 'No matches. You can use your typed value.'}</small>}
    </div>, document.body)}
  </div>;
}
