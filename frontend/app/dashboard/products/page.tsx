'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useBusinessStore } from '@/store/business';
import { useInstanceStore } from '@/store/instance';
import { productApi, productMediaApi, waApi } from '@/lib/api';
import CustomSelect from '@/components/ui/CustomSelect';

interface Product {
  id: string;
  title: string;
  description?: string;
  variations: string[];
  pricePerVariation: number[];
  stockPerVariation: number[];
  imageUrls: string[];
  price: number;
  stock: number;
  imageUrl?: string;
}

export default function ProductsPage() {
  const { currentBusiness } = useBusinessStore();
  const { instances, setInstances, selectedInstanceId, setSelectedInstanceId } = useInstanceStore();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [error, setError] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [variations, setVariations] = useState<string[]>([]);
  const [pricePerVariation, setPricePerVariation] = useState<number[]>([]);
  const [stockPerVariation, setStockPerVariation] = useState<number[]>([]);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [price, setPrice] = useState('');
  const [stock, setStock] = useState('0');
  const [imageUrl, setImageUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [bulkUploading, setBulkUploading] = useState(false);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'az' | 'za' | 'price_asc' | 'price_desc' | 'stock_asc' | 'stock_desc'>('az');
  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  useEffect(() => {
    if (currentBusiness) {
      waApi.listInstances(currentBusiness.id).then((res: any) => {
        if (res.data && Array.isArray(res.data.instances)) {
          setInstances(res.data.instances);
        }
      }).catch(() => {});
      fetchProducts();
    }
  }, [currentBusiness]);

  useEffect(() => {
    if (currentBusiness) {
      fetchProducts();
    }
  }, [selectedInstanceId]);

  const filteredProducts = products
    .filter(product => 
      product.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      product.description?.toLowerCase().includes(searchQuery.toLowerCase())
    )
    .sort((a, b) => {
      switch (sortBy) {
        case 'az': return a.title.localeCompare(b.title);
        case 'za': return b.title.localeCompare(a.title);
        case 'price_asc': return a.price - b.price;
        case 'price_desc': return b.price - a.price;
        case 'stock_asc': return a.stock - b.stock;
        case 'stock_desc': return b.stock - a.stock;
        default: return 0;
      }
    });

  const fetchProducts = async () => {
    if (!currentBusiness) return;
    
    try {
      const response = await productApi.list(currentBusiness.id, selectedInstanceId || undefined);
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
    setVariations([]);
    setPricePerVariation([]);
    setStockPerVariation([]);
    setImageUrls([]);
    setPrice('');
    setStock('0');
    setImageUrl('');
    setPendingFile(null);
    setImagePreview('');
    setEditingProduct(null);
    setShowForm(false);
    setCopied(false);
  };

  const toggleSelectProduct = (productId: string) => {
    const newSelected = new Set(selectedProducts);
    if (newSelected.has(productId)) {
      newSelected.delete(productId);
    } else {
      newSelected.add(productId);
    }
    setSelectedProducts(newSelected);
  };

  const toggleSelectAll = () => {
    if (selectedProducts.size === filteredProducts.length) {
      setSelectedProducts(new Set());
    } else {
      setSelectedProducts(new Set(filteredProducts.map(p => p.id)));
    }
  };

  const handleBulkDelete = async () => {
    if (!currentBusiness || selectedProducts.size === 0) return;
    
    if (!confirm(`¿Eliminar ${selectedProducts.size} productos seleccionados? Esta accion no se puede deshacer.`)) {
      return;
    }
    
    setBulkDeleting(true);
    try {
      await productApi.bulkDelete(currentBusiness.id, Array.from(selectedProducts));
      setSelectedProducts(new Set());
      fetchProducts();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al eliminar productos');
    } finally {
      setBulkDeleting(false);
    }
  };

  const handleFileUpload = async (file: File) => {
    if (!currentBusiness) return;
    if (!file.type.startsWith('image/')) {
      setError('Solo se permiten archivos de imagen');
      return;
    }
    
    setPendingFile(file);
    setImageUrl('');
    
    const reader = new FileReader();
    reader.onloadend = () => {
      setImagePreview(reader.result as string);
    };
    reader.readAsDataURL(file);
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
    const csvContent = `title,description,variations,pricePerVariation,stockPerVariation,imageUrls
"Serum Facial Vitamina C","Serum antioxidante concentrado","100ml | 50ml | 30ml","149.99 | 99.99 | 59.99","25 | 40 | 60","https://ejemplo.com/serum-100.jpg | https://ejemplo.com/serum-50.jpg"
"Camiseta Basica","Camiseta 100% algodon","Talla S | Talla M | Talla L | Talla XL","29.99 | 29.99 | 32.99 | 34.99","15 | 30 | 25 | 10","https://ejemplo.com/camiseta.jpg"
"Aceite Esencial Lavanda","Aceite puro para aromaterapia","10ml | 20ml","24.99 | 39.99","200 | 100","https://ejemplo.com/aceite.jpg"
"Arroz Premium","Arroz grano largo selecto","1kg | 5kg | 10kg","8.99 | 19.99 | 35.99","150 | 80 | 30",""
"Producto Simple","Producto sin variaciones","","49.99","100","https://ejemplo.com/simple.jpg"`;
    
    const BOM = '\uFEFF';
    const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'productos_ejemplo.csv';
    link.click();
  };

  const exportProductsToCsv = () => {
    if (products.length === 0) {
      setError('No hay productos para exportar');
      return;
    }
    
    const escapeCSV = (value: string) => {
      if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('|')) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    };
    
    const headers = 'title,description,variations,pricePerVariation,stockPerVariation,imageUrls';
    const rows = products.map(p => {
      const variationsStr = (p.variations || []).join(' | ');
      const pricesStr = (p.pricePerVariation || []).join(' | ');
      const stocksStr = (p.stockPerVariation || []).join(' | ');
      const imagesStr = (p.imageUrls || []).join(' | ');
      
      return [
        escapeCSV(p.title),
        escapeCSV(p.description || ''),
        escapeCSV(variationsStr),
        escapeCSV(pricesStr || String(p.price)),
        escapeCSV(stocksStr || String(p.stock)),
        escapeCSV(imagesStr || p.imageUrl || '')
      ].join(',');
    });
    
    const csvContent = [headers, ...rows].join('\n');
    const BOM = '\uFEFF';
    const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `productos_${currentBusiness?.name?.replace(/\s+/g, '_') || 'export'}_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
  };

  const parseArrayField = (value: string): string[] => {
    if (!value || !value.trim()) return [];
    return value.split('|').map(v => v.trim()).filter(Boolean);
  };

  const parseNumberArrayField = (value: string): number[] => {
    if (!value || !value.trim()) return [];
    return value.split('|').map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
  };

  const parseIntArrayField = (value: string): number[] => {
    if (!value || !value.trim()) return [];
    return value.split('|').map(v => parseInt(v.trim())).filter(v => !isNaN(v));
  };

  const handleCsvUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentBusiness) return;
    
    setBulkUploading(true);
    setError('');
    
    try {
      const arrayBuffer = await file.arrayBuffer();
      const decoder = new TextDecoder('utf-8');
      let text = decoder.decode(arrayBuffer);
      
      if (text.charCodeAt(0) === 0xFEFF) {
        text = text.slice(1);
      }
      
      const lines = text.split('\n').filter(line => line.trim());
      
      if (lines.length < 2) {
        setError('El CSV debe tener al menos una fila de datos ademas del encabezado');
        return;
      }
      
      const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
      const titleIdx = headers.indexOf('title');
      const descIdx = headers.indexOf('description');
      const variationsIdx = headers.indexOf('variations');
      const pricePerVariationIdx = headers.indexOf('pricepervariation');
      const stockPerVariationIdx = headers.indexOf('stockpervariation');
      const imageUrlsIdx = headers.indexOf('imageurls');
      
      if (titleIdx === -1) {
        setError('El CSV debe tener columna "title"');
        return;
      }
      
      const products = [];
      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        if (values.length > titleIdx) {
          const title = values[titleIdx]?.trim();
          
          if (title) {
            const variationsArr = variationsIdx >= 0 ? parseArrayField(values[variationsIdx] || '') : [];
            const pricePerVariationArr = pricePerVariationIdx >= 0 ? parseNumberArrayField(values[pricePerVariationIdx] || '') : [];
            const stockPerVariationArr = stockPerVariationIdx >= 0 ? parseIntArrayField(values[stockPerVariationIdx] || '') : [];
            const imageUrlsArr = imageUrlsIdx >= 0 ? parseArrayField(values[imageUrlsIdx] || '') : [];
            
            const hasVariations = variationsArr.length > 0;
            const firstPrice = pricePerVariationArr.length > 0 ? pricePerVariationArr[0] : 0;
            const totalStock = stockPerVariationArr.length > 0 ? stockPerVariationArr.reduce((a, b) => a + b, 0) : 0;
            const firstImage = imageUrlsArr.length > 0 ? imageUrlsArr[0] : null;
            
            products.push({
              title,
              description: descIdx >= 0 ? values[descIdx]?.trim() || null : null,
              variations: variationsArr,
              pricePerVariation: pricePerVariationArr,
              stockPerVariation: stockPerVariationArr,
              imageUrls: imageUrlsArr,
              price: firstPrice,
              stock: hasVariations ? totalStock : (stockPerVariationArr[0] || 0),
              imageUrl: firstImage
            });
          }
        }
      }
      
      if (products.length === 0) {
        setError('No se encontraron productos validos en el CSV');
        return;
      }
      
      const response = await productApi.bulkCreate(currentBusiness.id, products, selectedInstanceId || undefined);
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
    setVariations(product.variations || []);
    setPricePerVariation(product.pricePerVariation || []);
    setStockPerVariation(product.stockPerVariation || []);
    setImageUrls(product.imageUrls || []);
    setPrice(product.price.toString());
    setStock(product.stock?.toString() || '0');
    setImageUrl(product.imageUrl || '');
    setImagePreview(product.imageUrl || '');
    setPendingFile(null);
    setEditingProduct(product);
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentBusiness) return;

    setError('');
    setUploading(true);

    try {
      let finalImageUrl = imageUrl;
      let finalImageUrls = [...imageUrls];
      
      if (pendingFile && title.trim()) {
        const response = await productMediaApi.uploadImage(
          currentBusiness.id,
          pendingFile,
          title.trim()
        );
        finalImageUrl = response.data.url;
        if (finalImageUrls.length === 0) {
          finalImageUrls = [response.data.url];
        }
      }

      const hasVariations = variations.length > 0;
      const computedPrice = hasVariations && pricePerVariation.length > 0 ? pricePerVariation[0] : parseFloat(price) || 0;
      const computedStock = hasVariations && stockPerVariation.length > 0 ? stockPerVariation.reduce((a, b) => a + b, 0) : parseInt(stock) || 0;

      if (editingProduct) {
        await productApi.update(editingProduct.id, {
          title,
          description,
          variations,
          pricePerVariation,
          stockPerVariation,
          imageUrls: finalImageUrls,
          price: computedPrice,
          stock: computedStock,
          imageUrl: finalImageUrl || (finalImageUrls.length > 0 ? finalImageUrls[0] : null)
        });
      } else {
        await productApi.create({
          businessId: currentBusiness.id,
          instanceId: selectedInstanceId || null,
          title,
          description,
          variations,
          pricePerVariation,
          stockPerVariation,
          imageUrls: finalImageUrls,
          price: computedPrice,
          stock: computedStock,
          imageUrl: finalImageUrl || (finalImageUrls.length > 0 ? finalImageUrls[0] : null)
        });
      }
      
      fetchProducts();
      resetForm();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al guardar producto');
    } finally {
      setUploading(false);
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
        <div className="flex items-center gap-3">
          <h1 className="text-xl sm:text-2xl font-bold text-white">Productos</h1>
          {instances.length > 1 && (
            <CustomSelect
              value={selectedInstanceId || instances[0]?.id || ''}
              onChange={(val) => setSelectedInstanceId(val || null)}
              options={instances.map((inst: any) => ({
                value: inst.id,
                label: `${inst.name} ${inst.phoneNumber ? `(${inst.phoneNumber})` : ''}`
              }))}
              className="min-w-[160px]"
            />
          )}
        </div>
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
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as any)}
            className="px-3 py-2 bg-[#1e1e1e] border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-green-500"
          >
            <option value="az">A - Z</option>
            <option value="za">Z - A</option>
            <option value="price_asc">Precio: Menor a Mayor</option>
            <option value="price_desc">Precio: Mayor a Menor</option>
            <option value="stock_asc">Stock: Menor a Mayor</option>
            <option value="stock_desc">Stock: Mayor a Menor</option>
          </select>
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
            onClick={toggleSelectAll}
            className="btn btn-secondary text-sm"
          >
            {selectedProducts.size === filteredProducts.length && filteredProducts.length > 0 
              ? 'Deseleccionar todo' 
              : `Seleccionar todo (${filteredProducts.length})`}
          </button>
          {selectedProducts.size > 0 && (
            <button
              onClick={handleBulkDelete}
              disabled={bulkDeleting}
              className="btn bg-red-600 hover:bg-red-700 text-white text-sm"
            >
              {bulkDeleting ? 'Eliminando...' : `Eliminar (${selectedProducts.size})`}
            </button>
          )}
          <button
            onClick={downloadCsvExample}
            className="btn btn-secondary text-sm"
          >
            CSV ejemplo
          </button>
          {products.length > 0 && (
            <button
              onClick={exportProductsToCsv}
              className="btn btn-secondary text-sm"
            >
              Exportar CSV
            </button>
          )}
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
                  Descripcion
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="input resize-none"
                  rows={1}
                />
              </div>
            </div>

            {variations.length === 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                    required={variations.length === 0}
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
            ) : null}

            <div className="border border-gray-700 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <label className="block text-sm font-medium text-gray-300">
                  Variaciones
                  <span className="text-gray-500 text-xs ml-2">(ej: 100ml, 50ml, 30ml - cada una con su precio y stock)</span>
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setVariations([...variations, '']);
                    setPricePerVariation([...pricePerVariation, 0]);
                    setStockPerVariation([...stockPerVariation, 0]);
                  }}
                  className="btn btn-secondary text-xs px-2 py-1"
                >
                  + Agregar variacion
                </button>
              </div>
              
              {variations.length === 0 ? (
                <p className="text-gray-500 text-sm text-center py-2">
                  Sin variaciones. El producto tendra un unico precio y stock.
                </p>
              ) : (
                <div className="space-y-2">
                  {variations.map((v, idx) => (
                    <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                      <div className="col-span-5">
                        <input
                          type="text"
                          value={v}
                          onChange={(e) => {
                            const newVariations = [...variations];
                            newVariations[idx] = e.target.value;
                            setVariations(newVariations);
                          }}
                          className="input text-sm"
                          placeholder="Nombre variacion (ej: 100ml)"
                        />
                      </div>
                      <div className="col-span-3">
                        <input
                          type="number"
                          value={pricePerVariation[idx] || 0}
                          onChange={(e) => {
                            const newPrices = [...pricePerVariation];
                            newPrices[idx] = parseFloat(e.target.value) || 0;
                            setPricePerVariation(newPrices);
                          }}
                          className="input text-sm"
                          placeholder="Precio"
                          step="0.01"
                          min="0"
                        />
                      </div>
                      <div className="col-span-3">
                        <input
                          type="number"
                          value={stockPerVariation[idx] || 0}
                          onChange={(e) => {
                            const newStocks = [...stockPerVariation];
                            newStocks[idx] = parseInt(e.target.value) || 0;
                            setStockPerVariation(newStocks);
                          }}
                          className="input text-sm"
                          placeholder="Stock"
                          min="0"
                        />
                      </div>
                      <div className="col-span-1">
                        <button
                          type="button"
                          onClick={() => {
                            setVariations(variations.filter((_, i) => i !== idx));
                            setPricePerVariation(pricePerVariation.filter((_, i) => i !== idx));
                            setStockPerVariation(stockPerVariation.filter((_, i) => i !== idx));
                            setImageUrls(imageUrls.filter((_, i) => i !== idx));
                          }}
                          className="text-red-400 hover:text-red-300 p-1"
                          title="Eliminar variacion"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                  <div className="text-xs text-gray-500 mt-2">
                    Stock total: {stockPerVariation.reduce((a, b) => a + b, 0)} | 
                    Precio desde: {currentBusiness?.currencySymbol || '$'}{Math.min(...pricePerVariation.filter(p => p > 0), Infinity) === Infinity ? 0 : Math.min(...pricePerVariation.filter(p => p > 0))}
                  </div>
                </div>
              )}
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
                    <span className="text-gray-400">Guardando...</span>
                  </div>
                ) : (imagePreview || imageUrl) ? (
                  <div className="space-y-3">
                    <img 
                      src={imagePreview || imageUrl} 
                      alt="Preview" 
                      className="w-full max-h-40 object-contain rounded"
                    />
                    <p className="text-xs text-gray-500">
                      {pendingFile ? 'Imagen lista para subir al guardar' : 'Arrastra otra imagen para reemplazar'}
                    </p>
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
            <div key={product.id} className={`card card-hover relative ${selectedProducts.has(product.id) ? 'ring-2 ring-neon-blue' : ''}`}>
              <div className="absolute top-2 left-2 z-10">
                <input
                  type="checkbox"
                  checked={selectedProducts.has(product.id)}
                  onChange={() => toggleSelectProduct(product.id)}
                  className="w-5 h-5 rounded border-gray-600 bg-gray-700 text-neon-blue focus:ring-neon-blue cursor-pointer"
                />
              </div>
              {product.imageUrl && (
                <img
                  src={product.imageUrl}
                  alt={product.title}
                  className="w-full h-40 object-cover rounded-lg mb-3"
                />
              )}
              <h3 className="font-semibold text-white">{product.title}</h3>
              {product.variations && product.variations.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {product.variations.slice(0, 3).map((v, idx) => (
                    <span key={idx} className="inline-block text-xs bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded">
                      {v}
                    </span>
                  ))}
                  {product.variations.length > 3 && (
                    <span className="inline-block text-xs bg-gray-600/50 text-gray-400 px-2 py-0.5 rounded">
                      +{product.variations.length - 3} mas
                    </span>
                  )}
                </div>
              )}
              {product.description && (
                <p className="text-sm text-gray-400 mt-1 line-clamp-2">{product.description}</p>
              )}
              <div className="flex items-center justify-between mt-2">
                <p className="text-lg font-bold text-neon-blue">
                  {product.variations && product.variations.length > 1 
                    ? `Desde ${currentBusiness?.currencySymbol || 'S/.'}${Math.min(...(product.pricePerVariation || [product.price]).filter(p => p > 0)).toFixed(2)}`
                    : `${currentBusiness?.currencySymbol || 'S/.'}${product.price.toFixed(2)}`
                  }
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
            <div className="col-span-1"></div>
            <div className="col-span-1">Imagen</div>
            <div className="col-span-3">Producto</div>
            <div className="col-span-2">Precio</div>
            <div className="col-span-2">Stock</div>
            <div className="col-span-3">Acciones</div>
          </div>
          {filteredProducts.map((product) => (
            <div key={product.id} className={`card card-hover ${selectedProducts.has(product.id) ? 'ring-2 ring-neon-blue' : ''}`}>
              <div className="flex flex-col sm:grid sm:grid-cols-12 gap-4 items-center">
                <div className="col-span-1 flex items-center justify-center">
                  <input
                    type="checkbox"
                    checked={selectedProducts.has(product.id)}
                    onChange={() => toggleSelectProduct(product.id)}
                    className="w-5 h-5 rounded border-gray-600 bg-gray-700 text-neon-blue focus:ring-neon-blue cursor-pointer"
                  />
                </div>
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
                <div className="col-span-3 w-full sm:w-auto">
                  <h3 className="font-semibold text-white">{product.title}</h3>
                  {product.variations && product.variations.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {product.variations.slice(0, 2).map((v, idx) => (
                        <span key={idx} className="text-xs bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded">
                          {v}
                        </span>
                      ))}
                      {product.variations.length > 2 && (
                        <span className="text-xs bg-gray-600/50 text-gray-400 px-2 py-0.5 rounded">
                          +{product.variations.length - 2}
                        </span>
                      )}
                    </div>
                  )}
                  {product.description && (
                    <p className="text-sm text-gray-400 truncate max-w-xs">{product.description}</p>
                  )}
                </div>
                <div className="col-span-2 w-full sm:w-auto">
                  <p className="text-lg font-bold text-neon-blue">
                    {product.variations && product.variations.length > 1 
                      ? `Desde ${currentBusiness?.currencySymbol || 'S/.'}${Math.min(...(product.pricePerVariation || [product.price]).filter(p => p > 0)).toFixed(2)}`
                      : `${currentBusiness?.currencySymbol || 'S/.'}${product.price.toFixed(2)}`
                    }
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
