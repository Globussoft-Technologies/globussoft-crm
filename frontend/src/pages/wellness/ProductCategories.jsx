import { useState, useEffect, useRef } from 'react';
import { Layers, Plus, Edit2, Trash2, AlertCircle, Upload } from 'lucide-react';
import { fetchApi, getAuthToken } from '../../utils/api';
import { useNotify } from '../../utils/notify';

export default function ProductCategories() {
  const notify = useNotify();
  const fileInputRef = useRef(null);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    parentId: null,
    imageUrl: '',
    color: '',
    isActive: true,
  });

  useEffect(() => {
    loadCategories();
  }, []);

  const loadCategories = async () => {
    try {
      setLoading(true);
      const res = await fetchApi('/api/wellness/product-categories');
      setCategories(res || []);
    } catch (err) {
      notify.error('Failed to load categories');
    } finally {
      setLoading(false);
    }
  };

  const handleOpenModal = (category = null) => {
    if (category) {
      setEditingId(category.id);
      setFormData({
        name: category.name,
        parentId: category.parentId,
        imageUrl: category.imageUrl || '',
        color: category.color || '',
        isActive: category.isActive,
      });
    } else {
      setEditingId(null);
      setFormData({
        name: '',
        parentId: null,
        imageUrl: '',
        color: '',
        isActive: true,
      });
    }
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!formData.name.trim()) {
      notify.error('Category name is required');
      return;
    }

    try {
      if (editingId) {
        await fetchApi(`/api/wellness/product-categories/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify(formData),
        });
        notify.success('Category updated successfully');
      } else {
        await fetchApi('/api/wellness/product-categories', {
          method: 'POST',
          body: JSON.stringify(formData),
        });
        notify.success('Category created successfully');
      }
      setShowModal(false);
      loadCategories();
    } catch (err) {
      const errorMsg = err.message || 'Failed to save category';
      console.error('[ProductCategories]', errorMsg, err);
      notify.error(errorMsg);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this category? Products will become uncategorized.')) return;

    try {
      await fetchApi(`/api/wellness/product-categories/${id}`, { method: 'DELETE' });
      notify.success('Category deleted');
      loadCategories();
    } catch (err) {
      notify.error('Failed to delete category');
    }
  };

  const handleImageUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      setUploading(true);
      const formDataObj = new FormData();
      formDataObj.append('file', file);

      const response = await fetch('/api/wellness/upload/category-image', {
        method: 'POST',
        body: formDataObj,
        headers: {
          'Authorization': `Bearer ${getAuthToken()}`,
        },
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Upload failed');
      }

      const result = await response.json();
      setFormData({ ...formData, imageUrl: result.url });
      notify.success('Image uploaded successfully');
    } catch (err) {
      notify.error(err.message || 'Failed to upload image');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '2rem 1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Layers size={28} color="var(--accent-color)" />
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600, margin: 0 }}>Product Categories</h1>
        </div>
        <button
          onClick={() => handleOpenModal()}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.6rem 1.25rem',
            background: 'var(--accent-color)',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          <Plus size={16} /> Add Category
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
          Loading categories...
        </div>
      ) : categories.length === 0 ? (
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          <AlertCircle size={24} style={{ margin: '0 auto 0.5rem', opacity: 0.5 }} />
          No categories yet. Create one to organize your products.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '1rem' }}>
          {categories.map((cat) => (
            <div key={cat.id} className="glass" style={{ padding: '1rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
              {cat.imageUrl && (
                <img
                  src={cat.imageUrl}
                  alt={cat.name}
                  style={{ width: 60, height: 60, borderRadius: 8, objectFit: 'cover' }}
                />
              )}
              <div style={{ flex: 1 }}>
                <h3 style={{ margin: '0 0 0.25rem 0', fontWeight: 600 }}>{cat.name}</h3>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  {cat._count?.products || 0} products • {cat._count?.children || 0} subcategories
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  onClick={() => handleOpenModal(cat)}
                  style={{
                    padding: '0.5rem 0.75rem',
                    background: 'rgba(168, 85, 247, 0.1)',
                    border: 'none',
                    borderRadius: 6,
                    cursor: 'pointer',
                    color: 'var(--accent-color)',
                  }}
                >
                  <Edit2 size={16} />
                </button>
                <button
                  onClick={() => handleDelete(cat.id)}
                  style={{
                    padding: '0.5rem 0.75rem',
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: 'none',
                    borderRadius: 6,
                    cursor: 'pointer',
                    color: '#ef4444',
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000,
        }} onClick={() => setShowModal(false)}>
          <div
            className="glass"
            style={{ padding: '2rem', borderRadius: 12, maxWidth: 500, width: '90%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ marginTop: 0, marginBottom: '1.5rem' }}>
              {editingId ? 'Edit Category' : 'New Category'}
            </h2>

            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                Category Name *
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  borderRadius: 6,
                  border: '1px solid var(--border-color)',
                  fontSize: '1rem',
                }}
              />
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                Category Image
              </label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleImageUpload}
                style={{ display: 'none' }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  borderRadius: 6,
                  border: '2px dashed var(--border-color)',
                  background: 'transparent',
                  cursor: uploading ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem',
                  fontSize: '1rem',
                  color: uploading ? 'var(--text-secondary)' : 'var(--accent-color)',
                  fontWeight: 500,
                }}
              >
                <Upload size={18} />
                {uploading ? 'Uploading...' : 'Click to upload image'}
              </button>
              {formData.imageUrl && (
                <div style={{ marginTop: '0.75rem' }}>
                  <img
                    src={formData.imageUrl}
                    alt="Preview"
                    style={{
                      width: '100%',
                      height: 100,
                      objectFit: 'cover',
                      borderRadius: 6,
                      border: '1px solid var(--border-color)',
                    }}
                  />
                </div>
              )}
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                Color
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <input
                  type="color"
                  value={formData.color || '#265855'}
                  onChange={(e) => setFormData({ ...formData, color: e.target.value })}
                  style={{
                    width: '60px',
                    height: '40px',
                    borderRadius: 6,
                    border: '1px solid var(--border-color)',
                    cursor: 'pointer',
                  }}
                />
                <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                  {formData.color || '#265855'}
                </span>
              </div>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.5rem' }}>
              <input
                type="checkbox"
                checked={formData.isActive}
                onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
              />
              <span>Active</span>
            </label>

            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowModal(false)}
                style={{
                  padding: '0.6rem 1.25rem',
                  background: 'transparent',
                  border: '1px solid var(--border-color)',
                  borderRadius: 6,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                style={{
                  padding: '0.6rem 1.25rem',
                  background: 'var(--accent-color)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontWeight: 500,
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
