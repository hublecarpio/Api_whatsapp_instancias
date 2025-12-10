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
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

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
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (currentBusiness) {
      fetchProducts();
    }
  }, [currentBusiness]);

  const filteredProducts = products.filter(product => 
    product.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    product.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

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
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar productos..."
              className="w-48 sm:w-64 px-3 py-2 pl-9 bg-[#1e1e1e] border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-green-500 placeholder-gray-500"
            />
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <div className="flex bg-[#1e1e1e] rounded-lg p-1 border border-gray-700">
            <button
              onClick={() => setViewMode('grid')}
              className={`px-3 py-1.5 rounded text-sm transition-colors ${
                viewMode === 'grid'
                  ? 'bg-green-600 text-white'
                  : 'text-gray-400 hover:text-white'
              }`}
              title="Vista mosaico"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path d="M5 3a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2V5a2 2 0 00-2-2H5zM5 11a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 00-2-2H5zM11 5a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V5zM11 13a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
              </svg>
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`px-3 py-1.5 rounded text-sm transition-colors ${
                viewMode === 'list'
                  ? 'bg-green-600 text-white'
                  : 'text-gray-400 hover:text-white'
              }`}
              title="Vista listado"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
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
      ) : filteredProducts.length === 0 ? (
        <div className="card text-center py-12">
          <div className="text-6xl mb-4">📦</div>
          <p className="text-gray-400">No tienes productos todavia.</p>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredProducts.map((product) => (
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
                <p className="text-sm text-gray-400 mt-1 line-clamp-2">{product.description}</p>
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
      ) : (
        <div className="space-y-2">
          <div className="hidden sm:grid sm:grid-cols-12 gap-4 px-4 py-2 text-xs text-gray-500 uppercase font-medium">
            <div className="col-span-1">Imagen</div>
            <div className="col-span-4">Producto</div>
            <div className="col-span-2">Precio</div>
            <div className="col-span-2">Stock</div>
            <div className="col-span-3">Acciones</div>
          </div>
          {filteredProducts.map((product) => (
            <div key={product.id} className="card card-hover">
              <div className="flex flex-col sm:grid sm:grid-cols-12 gap-4 items-center">
                <div className="col-span-1 w-full sm:w-auto">
                  {product.imageUrl ? (
                    <img
                      src={product.imageUrl}
                      alt={product.title}
                      className="w-full sm:w-12 sm:h-12 h-32 object-cover rounded-lg"
                    />
                  ) : (
                    <div className="w-full sm:w-12 sm:h-12 h-32 bg-gray-700 rounded-lg flex items-center justify-center">
                      <span className="text-gray-500 text-2xl">📷</span>
                    </div>
                  )}
                </div>
                <div className="col-span-4 w-full sm:w-auto">
                  <h3 className="font-semibold text-white">{product.title}</h3>
                  {product.description && (
                    <p className="text-sm text-gray-400 truncate max-w-xs">{product.description}</p>
                  )}
                </div>
                <div className="col-span-2 w-full sm:w-auto">
                  <p className="text-lg font-bold text-neon-blue">
                    {currentBusiness?.currencySymbol || 'S/.'}{product.price.toFixed(2)}
                  </p>
                </div>
                <div className="col-span-2 w-full sm:w-auto">
                  <span className={`text-sm px-2 py-0.5 rounded ${
                    product.stock > 0 
                      ? 'bg-accent-success/20 text-accent-success' 
                      : 'bg-accent-error/20 text-accent-error'
                  }`}>
                    {product.stock ?? 0} unidades
                  </span>
                </div>
                <div className="col-span-3 flex gap-2 w-full sm:w-auto">
                  <button
                    onClick={() => handleEdit(product)}
                    className="btn btn-secondary btn-sm flex-1 sm:flex-none"
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
