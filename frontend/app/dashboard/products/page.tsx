'use client';

import { useState, useEffect } from 'react';
import { useBusinessStore } from '@/store/business';
import { productApi } from '@/lib/api';

interface Product {
  id: string;
  title: string;
  description?: string;
  price: number;
  imageUrl?: string;
}

export default function ProductsPage() {
  const { currentBusiness } = useBusinessStore();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [error, setError] = useState('');

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [imageUrl, setImageUrl] = useState('');

  useEffect(() => {
    if (currentBusiness) {
      fetchProducts();
    }
  }, [currentBusiness]);

  const fetchProducts = async () => {
    if (!currentBusiness) return;
    
    try {
      const response = await productApi.list(currentBusiness.id);
      setProducts(response.data);
    } catch (err) {
      console.error('Failed to fetch products:', err);
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setTitle('');
    setDescription('');
    setPrice('');
    setImageUrl('');
    setEditingProduct(null);
    setShowForm(false);
  };

  const handleEdit = (product: Product) => {
    setTitle(product.title);
    setDescription(product.description || '');
    setPrice(product.price.toString());
    setImageUrl(product.imageUrl || '');
    setEditingProduct(product);
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentBusiness) return;

    setError('');

    try {
      if (editingProduct) {
        await productApi.update(editingProduct.id, {
          title,
          description,
          price: parseFloat(price),
          imageUrl
        });
      } else {
        await productApi.create({
          businessId: currentBusiness.id,
          title,
          description,
          price: parseFloat(price),
          imageUrl
        });
      }
      
      fetchProducts();
      resetForm();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al guardar producto');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Estas seguro de eliminar este producto?')) return;

    try {
      await productApi.delete(id);
      fetchProducts();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al eliminar producto');
    }
  };

  if (!currentBusiness) {
    return (
      <div className="card text-center py-12">
        <p className="text-gray-400">
          Primero debes crear una empresa para gestionar productos.
        </p>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-0">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <h1 className="text-xl sm:text-2xl font-bold text-white">Productos</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="btn btn-primary w-full sm:w-auto"
        >
          {showForm ? 'Cancelar' : '+ Agregar producto'}
        </button>
      </div>

      {error && (
        <div className="bg-accent-error/10 border border-accent-error/20 text-accent-error px-4 py-3 rounded-lg mb-4">
          {error}
        </div>
      )}

      {showForm && (
        <div className="card mb-6">
          <h2 className="text-lg font-semibold text-white mb-4">
            {editingProduct ? 'Editar producto' : 'Nuevo producto'}
          </h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Titulo *
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="input"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Precio *
                </label>
                <input
                  type="number"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  className="input"
                  step="0.01"
                  min="0"
                  required
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Descripcion
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="input resize-none"
                rows={2}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                URL de imagen
              </label>
              <input
                type="url"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                className="input"
                placeholder="https://..."
              />
            </div>
            <div className="flex flex-col sm:flex-row gap-3">
              <button type="submit" className="btn btn-primary">
                {editingProduct ? 'Actualizar' : 'Crear producto'}
              </button>
              <button
                type="button"
                onClick={resetForm}
                className="btn btn-secondary"
              >
                Cancelar
              </button>
            </div>
          </form>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-neon-blue mx-auto"></div>
        </div>
      ) : products.length === 0 ? (
        <div className="card text-center py-12">
          <div className="text-6xl mb-4">📦</div>
          <p className="text-gray-400">No tienes productos todavia.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {products.map((product) => (
            <div key={product.id} className="card card-hover">
              {product.imageUrl && (
                <img
                  src={product.imageUrl}
                  alt={product.title}
                  className="w-full h-40 object-cover rounded-lg mb-3"
                />
              )}
              <h3 className="font-semibold text-white">{product.title}</h3>
              {product.description && (
                <p className="text-sm text-gray-400 mt-1">{product.description}</p>
              )}
              <p className="text-lg font-bold text-neon-blue mt-2">
                ${product.price.toFixed(2)}
              </p>
              <div className="flex gap-2 mt-4">
                <button
                  onClick={() => handleEdit(product)}
                  className="btn btn-secondary btn-sm flex-1"
                >
                  Editar
                </button>
                <button
                  onClick={() => handleDelete(product.id)}
                  className="btn btn-danger btn-sm"
                >
                  Eliminar
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
