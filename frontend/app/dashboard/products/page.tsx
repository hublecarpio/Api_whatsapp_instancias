'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useBusinessStore } from '@/store/business';
import { productApi, mediaApi } from '@/lib/api';

interface Product {
  id: string;
  title: string;
  description?: string;
  price: number;
  stock: number;
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
  const [stock, setStock] = useState('0');
  const [imageUrl, setImageUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [bulkUploading, setBulkUploading] = useState(false);
  const csvInputRef = useRef<HTMLInputElement>(null);

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
    setStock('0');
    setImageUrl('');
    setEditingProduct(null);
    setShowForm(false);
    setCopied(false);
  };

  const handleFileUpload = async (file: File) => {
    if (!currentBusiness) return;
    if (!file.type.startsWith('image/')) {
      setError('Solo se permiten archivos de imagen');
      return;
    }
    
    setUploading(true);
    setError('');
    
    try {
      const response = await mediaApi.upload(currentBusiness.id, file);
      setImageUrl(response.data.url);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al subir imagen');
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  }, [currentBusiness]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileUpload(file);
  };

  const copyToClipboard = () => {
    if (imageUrl) {
      navigator.clipboard.writeText(imageUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const downloadCsvExample = () => {
    const csvContent = `title,description,price,stock,imageUrl
"Producto ejemplo 1","Descripcion del producto 1",29.99,100,https://ejemplo.com/imagen1.jpg
"Producto ejemplo 2","Descripcion del producto 2",49.99,50,
"Producto sin descripcion",,19.99,25,https://ejemplo.com/imagen3.jpg`;
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'productos_ejemplo.csv';
    link.click();
  };

  const handleCsvUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentBusiness) return;
    
    setBulkUploading(true);
    setError('');
    
    try {
      const text = await file.text();
      const lines = text.split('\n').filter(line => line.trim());
      
      if (lines.length < 2) {
        setError('El CSV debe tener al menos una fila de datos ademas del encabezado');
        return;
      }
      
      const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
      const titleIdx = headers.indexOf('title');
      const descIdx = headers.indexOf('description');
      const priceIdx = headers.indexOf('price');
      const stockIdx = headers.indexOf('stock');
      const imageIdx = headers.indexOf('imageurl');
      
      if (titleIdx === -1 || priceIdx === -1) {
        setError('El CSV debe tener columnas "title" y "price"');
        return;
      }
      
      const products = [];
      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        if (values.length > Math.max(titleIdx, priceIdx)) {
          const title = values[titleIdx]?.trim();
          const price = parseFloat(values[priceIdx]?.trim() || '0');
          
          if (title && !isNaN(price)) {
            products.push({
              title,
              description: descIdx >= 0 ? values[descIdx]?.trim() || null : null,
              price,
              stock: stockIdx >= 0 ? parseInt(values[stockIdx]?.trim() || '0') || 0 : 0,
              imageUrl: imageIdx >= 0 ? values[imageIdx]?.trim() || null : null
            });
          }
        }
      }
      
      if (products.length === 0) {
        setError('No se encontraron productos validos en el CSV');
        return;
      }
      
      const response = await productApi.bulkCreate(currentBusiness.id, products);
      fetchProducts();
      alert(`Se crearon ${response.data.created} productos exitosamente${response.data.skipped > 0 ? `. ${response.data.skipped} filas fueron omitidas por datos invalidos.` : ''}`);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al procesar CSV');
    } finally {
      setBulkUploading(false);
      if (csvInputRef.current) csvInputRef.current.value = '';
    }
  };

  const parseCSVLine = (line: string): string[] => {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.replace(/^"|"$/g, ''));
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.replace(/^"|"$/g, ''));
    return result;
  };

  const handleEdit = (product: Product) => {
    setTitle(product.title);
    setDescription(product.description || '');
    setPrice(product.price.toString());
    setStock(product.stock?.toString() || '0');
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
          stock: parseInt(stock),
          imageUrl
        });
      } else {
        await productApi.create({
          businessId: currentBusiness.id,
          title,
          description,
          price: parseFloat(price),
          stock: parseInt(stock),
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
        <div className="flex flex-wrap gap-2">
          <button
            onClick={downloadCsvExample}
            className="btn btn-secondary text-sm"
          >
            Descargar CSV ejemplo
          </button>
          <label className={`btn btn-secondary text-sm cursor-pointer ${bulkUploading ? 'opacity-50' : ''}`}>
            {bulkUploading ? 'Subiendo...' : 'Importar CSV'}
            <input
              ref={csvInputRef}
              type="file"
              accept=".csv"
              onChange={handleCsvUpload}
              disabled={bulkUploading}
              className="hidden"
            />
          </label>
          <button
            onClick={() => setShowForm(!showForm)}
            className="btn btn-primary"
          >
            {showForm ? 'Cancelar' : '+ Agregar'}
          </button>
        </div>
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
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Stock
                </label>
                <input
                  type="number"
                  value={stock}
                  onChange={(e) => setStock(e.target.value)}
                  className="input"
                  min="0"
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
                Imagen del producto
              </label>
              <div
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-all ${
                  isDragging 
                    ? 'border-neon-blue bg-neon-blue/10' 
                    : 'border-gray-600 hover:border-gray-500'
                } ${uploading ? 'opacity-50 pointer-events-none' : ''}`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileSelect}
                  className="hidden"
                />
                {uploading ? (
                  <div className="flex items-center justify-center gap-2">
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-neon-blue"></div>
                    <span className="text-gray-400">Subiendo...</span>
                  </div>
                ) : imageUrl ? (
                  <div className="space-y-3">
                    <img 
                      src={imageUrl} 
                      alt="Preview" 
                      className="w-full max-h-40 object-contain rounded"
                    />
                    <p className="text-xs text-gray-500">Arrastra otra imagen para reemplazar</p>
                  </div>
                ) : (
                  <div className="text-gray-400">
                    <div className="text-3xl mb-2">📷</div>
                    <p className="text-sm">Arrastra una imagen aqui o haz clic para seleccionar</p>
                  </div>
                )}
              </div>
              
              {imageUrl && (
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="text"
                    value={imageUrl}
                    readOnly
                    className="input text-xs flex-1 bg-gray-800/50"
                  />
                  <button
                    type="button"
                    onClick={copyToClipboard}
                    className="btn btn-secondary btn-sm whitespace-nowrap"
                  >
                    {copied ? '✓ Copiado' : 'Copiar'}
                  </button>
                </div>
              )}
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
              <div className="flex items-center justify-between mt-2">
                <p className="text-lg font-bold text-neon-blue">
                  {currentBusiness?.currencySymbol || 'S/.'}{product.price.toFixed(2)}
                </p>
                <span className={`text-sm px-2 py-0.5 rounded ${
                  product.stock > 0 
                    ? 'bg-accent-success/20 text-accent-success' 
                    : 'bg-accent-error/20 text-accent-error'
                }`}>
                  Stock: {product.stock ?? 0}
                </span>
              </div>
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
