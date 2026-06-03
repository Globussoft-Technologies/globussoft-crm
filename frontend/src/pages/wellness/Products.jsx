import { useState, useEffect, useRef } from 'react';
import { Package, Plus, Edit2, Trash2, AlertCircle, Search, Upload } from 'lucide-react';
import { fetchApi, getAuthToken } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { usePermissions } from '../../hooks/usePermissions';

export default function Products() {
  const notify = useNotify();
  const fileInputRef = useRef(null);
  // Backend routes inventory.js gate POST=products.write,
  // PUT=products.update, DELETE=products.delete. We default to fail-closed
  // (canX=false until perms resolve) so buttons don't flash visible during
  // the initial permission fetch.
  const { hasPermission, isReady: permsReady, userType } = usePermissions();
  const canWriteProducts  = permsReady && hasPermission('products', 'write');
  const canUpdateProducts = permsReady && hasPermission('products', 'update');
  const canDeleteProducts = permsReady && hasPermission('products', 'delete');
  const canMutateProducts = canWriteProducts || canUpdateProducts || canDeleteProducts;
  // CUSTOMER users see a catalogue-only view: no SKU, stock, or product
  // type columns (backend strips these fields from the response anyway,
  // but hiding the columns keeps the table compact and honest about
  // what's renderable). Pairs with the allowCustomer opt-in on
  // GET /api/wellness/products.
  const isCustomerView = userType === 'CUSTOMER';
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [selectedProductForDetails, setSelectedProductForDetails] = useState(null);
  const [recentConsumption, setRecentConsumption] = useState([]);
  const [loadingConsumption, setLoadingConsumption] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [uploading, setUploading] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    sku: '',
    description: '',
    price: 0,
    categoryId: '',
    brandName: '',
    productType: 'Sale',
    productCode: '',
    hsnCode: '',
    volume: '',
    unit: '',
    discountedPrice: '',
    dealerPrice: '',
    purchasePrice: '',
    manufacturer: '',
    tax: '',
    isTaxIncluded: false,
    barcode: '',
    imageUrl: '',
    threshold: 0,
    currentStock: 0,
    isActive: true,
  });

  useEffect(() => {
    loadData();
  }, []);

  // Fetch the last 5 CONSUMPTION movements when the details modal opens so
  // the user can trace which completed visits actually drove the deductions.
  useEffect(() => {
    if (!selectedProductForDetails?.id) {
      setRecentConsumption([]);
      return;
    }
    let cancelled = false;
    setLoadingConsumption(true);
    fetchApi(`/api/wellness/inventory/movements?productId=${selectedProductForDetails.id}`)
      .then((res) => {
        if (cancelled) return;
        const movs = Array.isArray(res?.movements) ? res.movements : [];
        const consumption = movs.filter((m) => m.kind === 'CONSUMPTION').slice(0, 5);
        setRecentConsumption(consumption);
      })
      .catch(() => { if (!cancelled) setRecentConsumption([]); })
      .finally(() => { if (!cancelled) setLoadingConsumption(false); });
    return () => { cancelled = true; };
  }, [selectedProductForDetails?.id]);

  const loadData = async () => {
    try {
      setLoading(true);
      const [productsRes, categoriesRes] = await Promise.all([
        fetchApi('/api/wellness/products'),
        fetchApi('/api/wellness/product-categories'),
      ]);
      setProducts(productsRes || []);
      setCategories(categoriesRes || []);
    } catch (err) {
      notify.error('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const filteredProducts = products.filter(p => {
    const matchesSearch = p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         (p.sku && p.sku.toLowerCase().includes(searchTerm.toLowerCase()));
    const matchesCategory = !filterCategory || p.categoryId === parseInt(filterCategory);
    return matchesSearch && matchesCategory;
  });

  const handleOpenModal = (product = null) => {
    if (product) {
      setEditingId(product.id);
      setFormData({
        name: product.name,
        sku: product.sku || '',
        description: product.description || '',
        price: product.price || 0,
        categoryId: product.categoryId || '',
        brandName: product.brandName || '',
        productType: product.productType || 'Sale',
        productCode: product.productCode || '',
        hsnCode: product.hsnCode || '',
        volume: product.volume || '',
        unit: product.unit || '',
        discountedPrice: product.discountedPrice || '',
        dealerPrice: product.dealerPrice || '',
        purchasePrice: product.purchasePrice || '',
        manufacturer: product.manufacturer || '',
        tax: product.tax || '',
        isTaxIncluded: product.isTaxIncluded || false,
        barcode: product.barcode || '',
        imageUrl: product.imageUrl || '',
        threshold: product.threshold || 0,
        currentStock: product.currentStock || 0,
        isActive: product.isActive,
      });
    } else {
      setEditingId(null);
      setFormData({
        name: '',
        sku: '',
        description: '',
        price: 0,
        categoryId: '',
        brandName: '',
        productType: 'Sale',
        productCode: '',
        hsnCode: '',
        volume: '',
        unit: '',
        discountedPrice: '',
        dealerPrice: '',
        purchasePrice: '',
        manufacturer: '',
        tax: '',
        isTaxIncluded: false,
        barcode: '',
        imageUrl: '',
        threshold: 0,
        currentStock: 0,
        isActive: true,
      });
    }
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!formData.name.trim()) {
      notify.error('Product name is required');
      return;
    }

    try {
      if (editingId) {
        await fetchApi(`/api/wellness/products/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify(formData),
        });
        notify.success('Product updated successfully');
      } else {
        await fetchApi('/api/wellness/products', {
          method: 'POST',
          body: JSON.stringify(formData),
        });
        notify.success('Product created successfully');
      }
      setShowModal(false);
      loadData();
    } catch (err) {
      const errorMsg = err.message || 'Failed to save product';
      console.error('[Products]', errorMsg, err);
      notify.error(errorMsg);
    }
  };

  const handleDelete = async (id) => {
    const ok = await notify.confirm({
      title: 'Delete product',
      message: 'Delete this product?',
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;

    try {
      await fetchApi(`/api/wellness/products/${id}`, { method: 'DELETE' });
      notify.success('Product deleted');
      loadData();
    } catch (err) {
      notify.error('Failed to delete product');
    }
  };

  const handleImageUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      setUploading(true);
      const formDataObj = new FormData();
      formDataObj.append('file', file);

      const response = await fetch('/api/wellness/upload/product-image', {
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

  const getCategoryName = (catId) => {
    const cat = categories.find(c => c.id === catId);
    return cat ? cat.name : 'Uncategorized';
  };

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: '2rem 1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <Package size={28} color="var(--accent-color)" />
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600, margin: 0 }}>Products</h1>
          {permsReady && !canMutateProducts && (
            <span
              title="You can view products but can't make changes."
              style={{
                fontSize: '0.7rem',
                padding: '0.2rem 0.55rem',
                borderRadius: 999,
                background: 'var(--subtle-bg)',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border-color)',
                fontWeight: 500,
              }}
            >
              View only
            </span>
          )}
        </div>
        {canWriteProducts && (
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
            <Plus size={16} /> Add Product
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem' }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <Search size={18} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
          <input
            type="text"
            placeholder="Search by name or SKU..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              width: '100%',
              padding: '0.75rem 0.75rem 0.75rem 2.75rem',
              borderRadius: 6,
              border: '1px solid var(--border-color)',
              fontSize: '1rem',
            }}
          />
        </div>
        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          style={{
            padding: '0.75rem',
            borderRadius: 6,
            border: '1px solid var(--border-color)',
            fontSize: '1rem',
            minWidth: 200,
          }}
        >
          <option value="">All Categories</option>
          {categories.map(cat => (
            <option key={cat.id} value={cat.id}>{cat.name}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
          Loading products...
        </div>
      ) : filteredProducts.length === 0 ? (
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          <AlertCircle size={24} style={{ margin: '0 auto 0.5rem', opacity: 0.5 }} />
          {products.length === 0 ? 'No products yet.' : 'No products match your filters.'}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border-color)' }}>
                <th style={{ textAlign: 'left', padding: '1rem', fontWeight: 600 }}>Product</th>
                {!isCustomerView && (
                  <th style={{ textAlign: 'left', padding: '1rem', fontWeight: 600 }}>SKU</th>
                )}
                <th style={{ textAlign: 'left', padding: '1rem', fontWeight: 600 }}>Category</th>
                <th style={{ textAlign: 'right', padding: '1rem', fontWeight: 600 }}>Price</th>
                {!isCustomerView && (
                  <th style={{ textAlign: 'center', padding: '1rem', fontWeight: 600 }}>Stock</th>
                )}
                {!isCustomerView && (
                  <th style={{ textAlign: 'center', padding: '1rem', fontWeight: 600 }}>Type</th>
                )}
                {(canUpdateProducts || canDeleteProducts) && (
                  <th style={{ textAlign: 'center', padding: '1rem', fontWeight: 600 }}>Actions</th>
                )}
              </tr>
            </thead>
            <tbody>
              {filteredProducts.map((product) => (
                <tr key={product.id} style={{ borderBottom: '1px solid var(--border-color)', hover: { background: 'rgba(168, 85, 247, 0.05)' } }}>
                  <td style={{ padding: '1rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      {product.imageUrl && (
                        <img
                          src={product.imageUrl}
                          alt={product.name}
                          style={{ width: 40, height: 40, borderRadius: 6, objectFit: 'cover' }}
                        />
                      )}
                      <div>
                        <div style={{ fontWeight: 500 }}>{product.name}</div>
                        {product.brandName && <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{product.brandName}</div>}
                      </div>
                    </div>
                  </td>
                  {!isCustomerView && (
                    <td style={{ padding: '1rem', fontFamily: 'monospace', fontSize: '0.9rem' }}>{product.sku || '-'}</td>
                  )}
                  <td style={{ padding: '1rem', fontSize: '0.9rem' }}>{product.category?.name || getCategoryName(product.categoryId)}</td>
                  <td style={{ padding: '1rem', textAlign: 'right', fontWeight: 500 }}>₹{(product.price ?? 0).toFixed(2)}</td>
                  {!isCustomerView && (
                    <td style={{ padding: '1rem', textAlign: 'center' }}>
                      <span
                        onClick={() => setSelectedProductForDetails(product)}
                        style={{
                          padding: '0.25rem 0.75rem',
                          background: product.currentStock > product.threshold ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                          color: product.currentStock > product.threshold ? '#22c55e' : '#ef4444',
                          borderRadius: 4,
                          fontSize: '0.85rem',
                          cursor: 'pointer',
                          display: 'inline-block',
                          transition: 'all 0.2s',
                        }}
                        onMouseEnter={(e) => e.target.style.opacity = '0.7'}
                        onMouseLeave={(e) => e.target.style.opacity = '1'}
                        title="Click to see details"
                      >
                        {product.currentStock}
                      </span>
                    </td>
                  )}
                  {!isCustomerView && (
                    <td style={{ padding: '1rem', textAlign: 'center', fontSize: '0.85rem' }}>{product.productType || '-'}</td>
                  )}
                  {(canUpdateProducts || canDeleteProducts) && (
                    <td style={{ padding: '1rem', textAlign: 'center' }}>
                      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
                        {canUpdateProducts && (
                          <button
                            onClick={() => handleOpenModal(product)}
                            aria-label={`Edit ${product.name}`}
                            style={{
                              padding: '0.4rem 0.6rem',
                              background: 'rgba(168, 85, 247, 0.1)',
                              border: 'none',
                              borderRadius: 6,
                              cursor: 'pointer',
                              color: 'var(--accent-color)',
                            }}
                          >
                            <Edit2 size={14} />
                          </button>
                        )}
                        {canDeleteProducts && (
                          <button
                            onClick={() => handleDelete(product.id)}
                            aria-label={`Delete ${product.name}`}
                            style={{
                              padding: '0.4rem 0.6rem',
                              background: 'rgba(239, 68, 68, 0.1)',
                              border: 'none',
                              borderRadius: 6,
                              cursor: 'pointer',
                              color: '#ef4444',
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Product Details Modal */}
      {selectedProductForDetails && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000,
        }} onClick={() => setSelectedProductForDetails(null)}>
          <div
            className="glass"
            style={{ padding: '2rem', borderRadius: 12, maxWidth: 600, width: '90%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ marginTop: 0, marginBottom: '1.5rem' }}>📦 {selectedProductForDetails.name}</h2>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginBottom: '2rem' }}>
              <div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>SKU</div>
                <div style={{ fontWeight: 600, fontSize: '1.1rem' }}>{selectedProductForDetails.sku || '—'}</div>
              </div>

              <div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Category</div>
                <div style={{ fontWeight: 600, fontSize: '1.1rem' }}>{getCategoryName(selectedProductForDetails.categoryId)}</div>
              </div>

              <div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Volume per unit</div>
                <div style={{ fontWeight: 600, fontSize: '1.1rem' }}>
                  {selectedProductForDetails.volume || '—'} {selectedProductForDetails.unit || 'units'}
                </div>
              </div>

              <div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Price</div>
                <div style={{ fontWeight: 600, fontSize: '1.1rem' }}>₹{(selectedProductForDetails.price ?? 0).toFixed(2)}</div>
              </div>
            </div>

            {/* Stock Summary */}
            <div style={{ padding: '1.5rem', background: 'rgba(16, 185, 129, 0.08)', borderRadius: 8, border: '1px solid rgba(16, 185, 129, 0.2)', marginBottom: '1.5rem' }}>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.75rem', fontWeight: 600 }}>Stock Summary</div>

              <div style={{ marginBottom: '1rem' }}>
                <div style={{ fontSize: '0.9rem', marginBottom: '0.5rem' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Units in stock: </span>
                  <strong style={{ fontSize: '1.3rem', color: '#10b981' }}>{selectedProductForDetails.currentStock}</strong>
                </div>
                {selectedProductForDetails.partialMlUsed > 0 && selectedProductForDetails.volume && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    (− {selectedProductForDetails.partialMlUsed.toFixed(1)} {selectedProductForDetails.unit} consumed from open unit)
                  </div>
                )}
              </div>

              {selectedProductForDetails.volume && (
                <>
                  <div style={{ paddingTop: '1rem', borderTop: '1px solid rgba(16, 185, 129, 0.2)' }}>
                    <div style={{ fontSize: '0.9rem', marginBottom: '0.5rem' }}>
                      <span style={{ color: 'var(--text-secondary)' }}>Total remaining: </span>
                      <strong style={{ fontSize: '1.3rem', color: '#10b981' }}>
                        {(selectedProductForDetails.currentStock * selectedProductForDetails.volume - (selectedProductForDetails.partialMlUsed || 0)).toLocaleString('en-IN')}
                      </strong>
                      <span style={{ marginLeft: '0.5rem', color: 'var(--text-secondary)' }}>{selectedProductForDetails.unit}</span>
                    </div>
                  </div>

                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.75rem', fontStyle: 'italic' }}>
                    = {selectedProductForDetails.currentStock} units × {selectedProductForDetails.volume} {selectedProductForDetails.unit}/unit − {(selectedProductForDetails.partialMlUsed || 0).toFixed(1)} {selectedProductForDetails.unit}
                  </div>
                </>
              )}
            </div>

            {/* Recent consumption (last 5 visits that deducted from this product) */}
            <div style={{ padding: '1rem 1.25rem', background: 'rgba(99, 102, 241, 0.06)', borderRadius: 8, border: '1px solid rgba(99, 102, 241, 0.18)', marginBottom: '1rem' }}>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', fontWeight: 600 }}>
                Recent consumption (last 5)
              </div>
              {loadingConsumption ? (
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Loading…</div>
              ) : recentConsumption.length === 0 ? (
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  No auto-consumption recorded yet for this product.
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--text-secondary)' }}>
                      <th style={{ padding: '0.3rem 0.4rem', fontWeight: 500 }}>When</th>
                      <th style={{ padding: '0.3rem 0.4rem', fontWeight: 500 }}>Visit</th>
                      <th style={{ padding: '0.3rem 0.4rem', fontWeight: 500, textAlign: 'right' }}>Deducted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentConsumption.map((m) => (
                      <tr key={m.id} style={{ borderTop: '1px solid rgba(99, 102, 241, 0.12)' }}>
                        <td style={{ padding: '0.4rem' }}>
                          {m.at ? new Date(m.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'}
                        </td>
                        <td style={{ padding: '0.4rem' }}>#{m.visitId ?? '—'}</td>
                        <td style={{ padding: '0.4rem', textAlign: 'right', fontWeight: 600, color: '#ef4444' }}>
                          {Number(m.delta).toFixed(1)} {selectedProductForDetails.unit || ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {selectedProductForDetails.threshold > 0 && (
              <div style={{ padding: '1rem', background: 'rgba(251, 146, 60, 0.08)', borderRadius: 8, border: '1px solid rgba(251, 146, 60, 0.2)', marginBottom: '1rem' }}>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Reorder threshold: <strong>{selectedProductForDetails.threshold} units</strong></div>
                <div style={{ fontSize: '0.8rem', color: selectedProductForDetails.currentStock <= selectedProductForDetails.threshold ? '#ef4444' : '#10b981', marginTop: '0.25rem' }}>
                  {selectedProductForDetails.currentStock <= selectedProductForDetails.threshold ? '⚠️ Below threshold' : '✓ Adequate stock'}
                </div>
              </div>
            )}

            <button
              onClick={() => setSelectedProductForDetails(null)}
              style={{
                width: '100%',
                padding: '0.75rem',
                background: 'var(--accent-color)',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}

      {showModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000, overflowY: 'auto',
        }} onClick={() => setShowModal(false)}>
          <div
            className="glass"
            style={{ padding: '2rem', borderRadius: 12, maxWidth: 700, width: '90%', margin: '2rem auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ marginTop: 0, marginBottom: '1.5rem' }}>
              {editingId ? 'Edit Product' : 'New Product'}
            </h2>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', maxHeight: '70vh', overflowY: 'auto', paddingRight: '0.5rem' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                  Product Name *
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

              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                  SKU
                </label>
                <input
                  type="text"
                  value={formData.sku}
                  onChange={(e) => setFormData({ ...formData, sku: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    borderRadius: 6,
                    border: '1px solid var(--border-color)',
                    fontSize: '1rem',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                  Brand Name
                </label>
                <input
                  type="text"
                  value={formData.brandName}
                  onChange={(e) => setFormData({ ...formData, brandName: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    borderRadius: 6,
                    border: '1px solid var(--border-color)',
                    fontSize: '1rem',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                  Category
                </label>
                <select
                  value={formData.categoryId}
                  onChange={(e) => setFormData({ ...formData, categoryId: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    borderRadius: 6,
                    border: '1px solid var(--border-color)',
                    fontSize: '1rem',
                  }}
                >
                  <option value="">Select Category</option>
                  {categories.map(cat => (
                    <option key={cat.id} value={cat.id}>{cat.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                  Price (MRP)
                </label>
                <input
                  type="number"
                  value={formData.price}
                  onChange={(e) => setFormData({ ...formData, price: e.target.value })}
                  step="0.01"
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    borderRadius: 6,
                    border: '1px solid var(--border-color)',
                    fontSize: '1rem',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                  Product Type
                </label>
                <select
                  value={formData.productType}
                  onChange={(e) => setFormData({ ...formData, productType: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    borderRadius: 6,
                    border: '1px solid var(--border-color)',
                    fontSize: '1rem',
                  }}
                >
                  <option value="Sale">Sale</option>
                  <option value="Consumption">Consumption</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                  Volume
                </label>
                <input
                  type="number"
                  value={formData.volume}
                  onChange={(e) => setFormData({ ...formData, volume: e.target.value })}
                  step="0.01"
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    borderRadius: 6,
                    border: '1px solid var(--border-color)',
                    fontSize: '1rem',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                  Unit
                </label>
                <select
                  value={formData.unit}
                  onChange={(e) => setFormData({ ...formData, unit: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    borderRadius: 6,
                    border: '1px solid var(--border-color)',
                    fontSize: '1rem',
                  }}
                >
                  <option value="">Select Unit</option>
                  <option value="ml">ml</option>
                  <option value="ltr">ltr</option>
                  <option value="gm">gm</option>
                  <option value="kg">kg</option>
                  <option value="piece">piece</option>
                  <option value="mg">mg</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                  Current Stock
                </label>
                <input
                  type="number"
                  value={formData.currentStock}
                  onChange={(e) => setFormData({ ...formData, currentStock: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    borderRadius: 6,
                    border: '1px solid var(--border-color)',
                    fontSize: '1rem',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                  Reorder Threshold
                </label>
                <input
                  type="number"
                  value={formData.threshold}
                  onChange={(e) => setFormData({ ...formData, threshold: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    borderRadius: 6,
                    border: '1px solid var(--border-color)',
                    fontSize: '1rem',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                  Barcode
                </label>
                <input
                  type="text"
                  value={formData.barcode}
                  onChange={(e) => setFormData({ ...formData, barcode: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    borderRadius: 6,
                    border: '1px solid var(--border-color)',
                    fontSize: '1rem',
                  }}
                />
              </div>

              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                  Product Image
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
                  type="button"
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
                        height: 150,
                        objectFit: 'cover',
                        borderRadius: 6,
                        border: '1px solid var(--border-color)',
                      }}
                    />
                  </div>
                )}
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  type="checkbox"
                  checked={formData.isActive}
                  onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
                />
                <span>Active</span>
              </label>
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '1.5rem' }}>
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
