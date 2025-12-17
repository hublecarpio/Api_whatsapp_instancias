'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { productApi } from '@/lib/api';

interface StepProductsProps {
  businessId: string;
  onComplete: () => void;
  onSkip: () => void;
}

interface QuickProduct {
  title: string;
  price: string;
  description: string;
  stock: string;
}

export default function StepProducts({ businessId, onComplete, onSkip }: StepProductsProps) {
  const [products, setProducts] = useState<QuickProduct[]>([
    { title: '', price: '', description: '', stock: '' }
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState(0);

  const updateProduct = (index: number, field: keyof QuickProduct, value: string) => {
    const updated = [...products];
    updated[index] = { ...updated[index], [field]: value };
    setProducts(updated);
  };

  const addProduct = () => {
    if (products.length < 5) {
      setProducts([...products, { title: '', price: '', description: '', stock: '' }]);
    }
  };

  const removeProduct = (index: number) => {
    if (products.length > 1) {
      setProducts(products.filter((_, i) => i !== index));
    }
  };

  const handleSave = async () => {
    const validProducts = products.filter(p => p.title.trim() && p.price.trim());
    
    if (validProducts.length === 0) {
      setError('Agrega al menos un producto con nombre y precio');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      for (const product of validProducts) {
        await productApi.create({
          businessId,
          title: product.title.trim(),
          description: product.description.trim() || null,
          price: parseFloat(product.price) || 0,
          stock: parseInt(product.stock) || 0
        });
        setSavedCount(prev => prev + 1);
      }
      
      setTimeout(onComplete, 500);
    } catch (err: any) {
      console.error('Error saving products:', err);
      setError(err.response?.data?.error || 'Error al guardar los productos');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h2 className="text-xl font-semibold text-white mb-2 text-center">Agrega tus productos o servicios</h2>
      <p className="text-gray-400 mb-6 text-center">El asistente usará esta información para responder a tus clientes</p>

      <div className="space-y-4 max-w-lg mx-auto">
        <AnimatePresence>
          {products.map((product, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="bg-[#12121f] rounded-xl p-4 border border-gray-800"
            >
              <div className="flex justify-between items-center mb-3">
                <span className="text-gray-400 text-sm">Producto {index + 1}</span>
                {products.length > 1 && (
                  <button
                    onClick={() => removeProduct(index)}
                    className="text-gray-500 hover:text-red-400 transition text-sm"
                  >
                    Eliminar
                  </button>
                )}
              </div>
              
              <div className="grid grid-cols-4 gap-3">
                <input
                  type="text"
                  placeholder="Nombre del producto"
                  value={product.title}
                  onChange={(e) => updateProduct(index, 'title', e.target.value)}
                  className="col-span-2 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:border-indigo-500 focus:outline-none"
                />
                <input
                  type="number"
                  placeholder="Precio"
                  value={product.price}
                  onChange={(e) => updateProduct(index, 'price', e.target.value)}
                  className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:border-indigo-500 focus:outline-none"
                />
                <input
                  type="number"
                  placeholder="Stock"
                  value={product.stock}
                  onChange={(e) => updateProduct(index, 'stock', e.target.value)}
                  className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:border-indigo-500 focus:outline-none"
                />
              </div>
              
              <input
                type="text"
                placeholder="Descripcion breve (opcional)"
                value={product.description}
                onChange={(e) => updateProduct(index, 'description', e.target.value)}
                className="mt-3 w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:border-indigo-500 focus:outline-none"
              />
            </motion.div>
          ))}
        </AnimatePresence>

        {products.length < 5 && (
          <button
            onClick={addProduct}
            className="w-full py-3 border-2 border-dashed border-gray-700 rounded-xl text-gray-400 hover:border-gray-500 hover:text-gray-300 transition text-sm"
          >
            + Agregar otro producto
          </button>
        )}

        {error && (
          <p className="text-red-400 text-sm text-center">{error}</p>
        )}

        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full py-3 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {saving ? (
            <>
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
              Guardando ({savedCount}/{products.filter(p => p.title.trim() && p.price.trim()).length})
            </>
          ) : (
            'Guardar productos'
          )}
        </button>
      </div>
    </div>
  );
}
