import React, { useState, useEffect, useContext } from 'react';
import { BookOpen, Plus, Edit, Trash2, Eye, FolderTree, Save, X, Globe } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { AuthContext } from '../App';

const EMPTY_ARTICLE = {
  title: '',
  slug: '',
  content: '',
  categoryId: '',
  isPublished: false,
};

export default function KnowledgeBase() {
  const notify = useNotify();
  const { tenant } = useContext(AuthContext);
  const [categories, setCategories] = useState([]);
  const [articles, setArticles] = useState([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState(null);
  const [editing, setEditing] = useState(null); // null | 'new' | article object
  const [form, setForm] = useState(EMPTY_ARTICLE);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => { loadAll(); }, []);

  const loadAll = async () => {
    try {
      const [cats, arts] = await Promise.all([
        fetchApi('/api/knowledge-base/categories'),
        fetchApi('/api/knowledge-base/articles'),
      ]);
      setCategories(Array.isArray(cats) ? cats : []);
      setArticles(Array.isArray(arts) ? arts : []);
    } catch (err) {
      console.error(err);
    }
  };

  const filteredArticles = selectedCategoryId
    ? articles.filter(a => a.categoryId === selectedCategoryId)
    : articles;

  const beginNew = () => {
    setForm({ ...EMPTY_ARTICLE, categoryId: selectedCategoryId || '' });
    setEditing('new');
  };

  const beginEdit = (article) => {
    setForm({
      title: article.title || '',
      slug: article.slug || '',
      content: article.content || '',
      categoryId: article.categoryId || '',
      isPublished: !!article.isPublished,
    });
    setEditing(article);
  };

  const cancelEdit = () => {
    setEditing(null);
    setForm(EMPTY_ARTICLE);
  };

  const saveArticle = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) {
      notify.error('Title is required');
      return;
    }
    setLoading(true);
    try {
      const payload = {
        title: form.title,
        content: form.content,
        categoryId: form.categoryId || null,
        isPublished: form.isPublished,
      };
      if (editing === 'new') {
        await fetchApi('/api/knowledge-base/articles', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      } else {
        if (form.slug) payload.slug = form.slug;
        await fetchApi(`/api/knowledge-base/articles/${editing.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      }
      cancelEdit();
      loadAll();
    } catch (err) {
      notify.error('Failed to save article');
    } finally {
      setLoading(false);
    }
  };

  const deleteArticle = async (id) => {
    if (!await notify.confirm('Delete this article? This cannot be undone.')) return;
    try {
      await fetchApi(`/api/knowledge-base/articles/${id}`, { method: 'DELETE' });
      loadAll();
    } catch (err) {
      console.error(err);
    }
  };

  const publishArticle = async (id) => {
    try {
      await fetchApi(`/api/knowledge-base/articles/${id}/publish`, { method: 'POST' });
      loadAll();
    } catch (err) {
      console.error(err);
    }
  };

  const createCategory = async () => {
    if (!newCategoryName.trim()) return;
    try {
      await fetchApi('/api/knowledge-base/categories', {
        method: 'POST',
        body: JSON.stringify({ name: newCategoryName.trim() }),
      });
      setNewCategoryName('');
      loadAll();
    } catch (err) {
      notify.error('Failed to create category');
    }
  };

  const deleteCategory = async (id) => {
    if (!await notify.confirm('Delete this category? Articles in it will be uncategorized.')) return;
    try {
      await fetchApi(`/api/knowledge-base/categories/${id}`, { method: 'DELETE' });
      if (selectedCategoryId === id) setSelectedCategoryId(null);
      loadAll();
    } catch (err) {
      console.error(err);
    }
  };

  const totalArticles = articles.length;
  const publishedCount = articles.filter(a => a.isPublished).length;
  const draftCount = totalArticles - publishedCount;
  const totalViews = articles.reduce((s, a) => s + (a.views || 0), 0);

  const tenantSlug = (typeof window !== 'undefined' && localStorage.getItem('tenantSlug')) || 'your-tenant';
  const publicUrlHint = `/api/knowledge-base/public/${tenantSlug}/articles`;

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <BookOpen size={26} color="var(--accent-color)" /> {tenant?.name ? `${tenant.name} Knowledge Base` : 'Knowledge Base'}
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            {totalArticles} {totalArticles === 1 ? 'article' : 'articles'} · Manage help articles and categories. Published articles are exposed to your customer portal.
          </p>
        </div>
        <button onClick={beginNew} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.7rem 1.2rem' }}>
          <Plus size={16} /> New Article
        </button>
      </header>

      {/* Stats bar */}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <span style={{
          padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem', fontWeight: '600',
          background: 'rgba(16,185,129,0.1)', color: '#10b981', border: '1px solid rgba(16,185,129,0.3)',
        }}>{publishedCount} Published</span>
        <span style={{
          padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem', fontWeight: '600',
          background: 'rgba(100,116,139,0.1)', color: '#94a3b8', border: '1px solid rgba(100,116,139,0.3)',
        }}>{draftCount} Drafts</span>
        <span style={{
          padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem', fontWeight: '600',
          background: 'var(--subtle-bg-4)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)',
          display: 'flex', alignItems: 'center', gap: '0.3rem',
        }}>
          <Eye size={14} /> {totalViews.toLocaleString()} total views
        </span>
      </div>

      {/* Public URL hint */}
      <div className="card" style={{ padding: '0.85rem 1.1rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.85rem' }}>
        <Globe size={16} color="var(--accent-color)" />
        <span style={{ color: 'var(--text-secondary)' }}>Public URL:</span>
        <code style={{ color: 'var(--text-primary)', background: 'var(--subtle-bg-2)', padding: '0.15rem 0.5rem', borderRadius: '4px', fontSize: '0.8rem' }}>
          {publicUrlHint}
        </code>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: '1.5rem' }}>
        {/* Categories tree */}
        <div className="card" style={{ padding: '1.25rem', height: 'fit-content' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: '600', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <FolderTree size={18} color="var(--accent-color)" /> Categories
          </h3>

          <div
            onClick={() => setSelectedCategoryId(null)}
            style={{
              padding: '0.5rem 0.75rem', borderRadius: '6px', cursor: 'pointer',
              background: selectedCategoryId === null ? 'var(--subtle-bg-4)' : 'transparent',
              fontWeight: selectedCategoryId === null ? '600' : 'normal',
              fontSize: '0.875rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}
          >
            <span>All Articles</span>
            <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>{articles.length}</span>
          </div>

          {categories.map(cat => (
            <div
              key={cat.id}
              style={{
                padding: '0.5rem 0.75rem', borderRadius: '6px', cursor: 'pointer',
                background: selectedCategoryId === cat.id ? 'var(--subtle-bg-4)' : 'transparent',
                fontWeight: selectedCategoryId === cat.id ? '600' : 'normal',
                fontSize: '0.875rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                marginTop: '0.25rem',
              }}
            >
              <span onClick={() => setSelectedCategoryId(cat.id)} style={{ flex: 1 }}>{cat.name}</span>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginRight: '0.5rem' }}>
                {cat.articleCount ?? 0}
              </span>
              <button
                onClick={() => deleteCategory(cat.id)}
                title="Delete category"
                style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '2px' }}
                onMouseOver={e => (e.currentTarget.style.color = '#ef4444')}
                onMouseOut={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}

          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.4rem' }}>
            <input
              className="input-field"
              placeholder="New category…"
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createCategory()}
              style={{ flex: 1, fontSize: '0.85rem', padding: '0.45rem 0.6rem' }}
            />
            <button
              onClick={createCategory}
              className="btn-primary"
              style={{ padding: '0.4rem 0.7rem', fontSize: '0.8rem' }}
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        {/* Right pane: editor or article list */}
        <div className="card" style={{ padding: '1.5rem' }}>
          {editing ? (
            <form key={editing === 'new' ? 'new' : `edit-${editing.id}`} onSubmit={saveArticle} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ fontSize: '1.1rem', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  {editing === 'new' ? <><Plus size={18} color="var(--accent-color)" /> New Article</> : <><Edit size={18} color="var(--accent-color)" /> Edit Article</>}
                </h3>
                <button type="button" onClick={cancelEdit} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                  <X size={16} /> Cancel
                </button>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.4rem', color: 'var(--text-secondary)' }}>Title</label>
                <input
                  className="input-field" required
                  placeholder="How to reset your password"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
              </div>

              {editing !== 'new' && (
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.4rem', color: 'var(--text-secondary)' }}>Slug</label>
                  <input
                    className="input-field"
                    placeholder="auto-generated from title"
                    value={form.slug}
                    onChange={(e) => setForm({ ...form, slug: e.target.value })}
                  />
                </div>
              )}

              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.4rem', color: 'var(--text-secondary)' }}>Category</label>
                <select
                  className="input-field"
                  value={form.categoryId || ''}
                  onChange={(e) => setForm({ ...form, categoryId: e.target.value ? parseInt(e.target.value) : '' })}
                  style={{ background: 'var(--input-bg)' }}
                >
                  <option value="">— Uncategorized —</option>
                  {categories.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <input
                  type="checkbox"
                  id="isPublished"
                  checked={!!form.isPublished}
                  onChange={(e) => setForm(prev => ({ ...prev, isPublished: e.target.checked }))}
                />
                <label htmlFor="isPublished" style={{ fontSize: '0.875rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
                  Published (visible on customer portal)
                </label>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.4rem', color: 'var(--text-secondary)' }}>Content (Markdown or HTML)</label>
                <textarea
                  className="input-field"
                  rows={14}
                  placeholder="Write your article content here…"
                  value={form.content}
                  onChange={(e) => setForm({ ...form, content: e.target.value })}
                  style={{ fontFamily: 'monospace', fontSize: '0.875rem' }}
                />
              </div>

              <button type="submit" className="btn-primary" disabled={loading} style={{ padding: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                <Save size={16} /> {loading ? 'Saving…' : (editing === 'new' ? 'Create Article' : 'Save Changes')}
              </button>
            </form>
          ) : (
            <>
              <h3 style={{ fontSize: '1.1rem', fontWeight: '600', marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <BookOpen size={18} color="var(--accent-color)" />
                {selectedCategoryId
                  ? `Articles in "${categories.find(c => c.id === selectedCategoryId)?.name || ''}"`
                  : 'All Articles'}
              </h3>

              {filteredArticles.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '3rem 2rem', background: 'var(--subtle-bg-2)', border: '1px dashed var(--border-color)', borderRadius: '8px' }}>
                  <BookOpen size={48} style={{ opacity: 0.2, margin: '0 auto 1rem', color: 'var(--accent-color)' }} />
                  <p style={{ color: 'var(--text-secondary)' }}>No articles yet. Click "New Article" to create one.</p>
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>
                        <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Title</th>
                        <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Category</th>
                        <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Status</th>
                        <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Views</th>
                        <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Updated</th>
                        <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredArticles.map(a => {
                        const cat = categories.find(c => c.id === a.categoryId);
                        return (
                          <tr key={a.id} style={{ borderBottom: '1px solid var(--border-color)', transition: '0.2s' }}
                            onMouseOver={e => (e.currentTarget.style.background = 'var(--subtle-bg-2)')}
                            onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
                          >
                            <td style={{ padding: '0.85rem 0.5rem', fontWeight: '600' }}>{a.title}</td>
                            <td style={{ padding: '0.85rem 0.5rem', color: 'var(--text-secondary)' }}>
                              {cat?.name || '—'}
                            </td>
                            <td style={{ padding: '0.85rem 0.5rem' }}>
                              <span style={{
                                padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.7rem', fontWeight: 'bold',
                                background: a.isPublished ? 'rgba(16,185,129,0.12)' : 'rgba(100,116,139,0.12)',
                                color: a.isPublished ? '#10b981' : '#94a3b8',
                                border: `1px solid ${a.isPublished ? 'rgba(16,185,129,0.3)' : 'rgba(100,116,139,0.3)'}`,
                              }}>
                                {a.isPublished ? 'Published' : 'Draft'}
                              </span>
                            </td>
                            <td style={{ padding: '0.85rem 0.5rem', color: 'var(--text-secondary)' }}>
                              {a.views || 0}
                            </td>
                            <td style={{ padding: '0.85rem 0.5rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                              {a.updatedAt ? new Date(a.updatedAt).toLocaleDateString() : '—'}
                            </td>
                            <td style={{ padding: '0.85rem 0.5rem' }}>
                              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                                <button
                                  onClick={() => beginEdit(a)}
                                  style={{
                                    background: 'transparent', border: '1px solid var(--border-color)',
                                    color: 'var(--text-primary)', cursor: 'pointer',
                                    display: 'flex', alignItems: 'center', gap: '0.25rem',
                                    fontSize: '0.75rem', padding: '0.35rem 0.65rem', borderRadius: '6px',
                                  }}
                                >
                                  <Edit size={12} /> Edit
                                </button>
                                {!a.isPublished && (
                                  <button
                                    onClick={() => publishArticle(a.id)}
                                    style={{
                                      background: 'var(--success-color)', color: '#fff', border: 'none',
                                      cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem',
                                      fontSize: '0.75rem', padding: '0.35rem 0.65rem', borderRadius: '6px',
                                    }}
                                  >
                                    <Eye size={12} /> Publish
                                  </button>
                                )}
                                <button
                                  onClick={() => deleteArticle(a.id)}
                                  style={{
                                    background: 'transparent', border: '1px solid rgba(239,68,68,0.3)',
                                    color: 'var(--text-secondary)', cursor: 'pointer',
                                    display: 'flex', alignItems: 'center', gap: '0.25rem',
                                    fontSize: '0.75rem', padding: '0.35rem 0.65rem', borderRadius: '6px',
                                  }}
                                  onMouseOver={e => (e.currentTarget.style.color = '#ef4444')}
                                  onMouseOut={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
                                >
                                  <Trash2 size={12} /> Delete
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  );
}
