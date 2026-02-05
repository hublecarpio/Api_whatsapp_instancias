'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';

interface Product {
  id: string;
  title: string;
  description: string | null;
  price: number;
  displayPrice: number;
  hasVariablePricing: boolean;
  imageUrl: string | null;
  imageUrls: string[];
  variations: string[];
  pricePerVariation: number[];
  stock: number;
  stockPerVariation: number[];
}

interface Catalog {
  businessName: string;
  description: string | null;
  logoUrl: string | null;
  industry: string | null;
  currencyCode: string;
  currencySymbol: string;
  whatsappPhone: string | null;
  products: Product[];
}

export default function CatalogPage() {
  const params = useParams();
  const slug = params.slug as string;
  
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedVariations, setSelectedVariations] = useState<Record<string, number>>({});

  useEffect(() => {
    async function fetchCatalog() {
      try {
        // Use relative URL to leverage Next.js rewrite proxy
        const res = await fetch(`/public/catalog/${slug}`);
        const data = await res.json();
        
        if (!res.ok) {
          setError(data.error || 'Catálogo no encontrado');
          return;
        }
        
        setCatalog(data.catalog);
      } catch (err) {
        setError('Error al cargar el catálogo');
      } finally {
        setLoading(false);
      }
    }
    
    if (slug) {
      fetchCatalog();
    }
  }, [slug]);

  const getProductPrice = (product: Product, variationIndex?: number) => {
    if (variationIndex !== undefined && product.pricePerVariation[variationIndex]) {
      return product.pricePerVariation[variationIndex];
    }
    return product.price;
  };

  const getWhatsAppLink = (product: Product, variationIndex?: number) => {
    if (!catalog?.whatsappPhone) return null;
    
    const variation = variationIndex !== undefined && product.variations[variationIndex] 
      ? ` (${product.variations[variationIndex]})` 
      : '';
    const price = getProductPrice(product, variationIndex);
    
    const message = `¡Hola! Me interesa el producto:\n\n*${product.title}${variation}*\nPrecio: ${catalog.currencySymbol}${price.toFixed(2)}\n\n¿Está disponible?`;
    
    return `https://wa.me/${catalog.whatsappPhone}?text=${encodeURIComponent(message)}`;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600"></div>
      </div>
    );
  }

  if (error || !catalog) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-800 mb-2">Catálogo no encontrado</h1>
          <p className="text-gray-600 mb-4">{error || 'El catálogo que buscas no existe o no está disponible.'}</p>
          <Link href="/" className="text-green-600 hover:text-green-700 font-medium">
            Volver al inicio
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-4">
            {catalog.logoUrl && (
              <Image
                src={catalog.logoUrl}
                alt={catalog.businessName}
                width={48}
                height={48}
                className="rounded-full object-cover"
              />
            )}
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900">{catalog.businessName}</h1>
              {catalog.industry && (
                <p className="text-sm text-gray-500">{catalog.industry}</p>
              )}
            </div>
          </div>
          {catalog.description && (
            <p className="mt-2 text-gray-600 text-sm">{catalog.description}</p>
          )}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8 sm:px-6 lg:px-8">
        {catalog.products.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-500">Este catálogo aún no tiene productos.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {catalog.products.map((product) => {
              const selectedVariation = selectedVariations[product.id];
              const currentPrice = getProductPrice(product, selectedVariation);
              const whatsappLink = getWhatsAppLink(product, selectedVariation);
              
              return (
                <div key={product.id} className="bg-white rounded-xl shadow-sm overflow-hidden hover:shadow-md transition-shadow">
                  <div className="aspect-square relative bg-gray-100">
                    {product.imageUrl ? (
                      <Image
                        src={product.imageUrl}
                        alt={product.title}
                        fill
                        className="object-cover"
                        sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-gray-400">
                        <svg className="w-16 h-16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                      </div>
                    )}
                  </div>
                  
                  <div className="p-4">
                    <h3 className="font-semibold text-gray-900 mb-1 line-clamp-2">{product.title}</h3>
                    {product.description && (
                      <p className="text-sm text-gray-500 mb-2 line-clamp-2">{product.description}</p>
                    )}
                    
                    {product.variations.length > 0 && (
                      <div className="mb-3">
                        <select
                          value={selectedVariation ?? ''}
                          onChange={(e) => setSelectedVariations({
                            ...selectedVariations,
                            [product.id]: e.target.value ? parseInt(e.target.value) : undefined as any
                          })}
                          className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white text-gray-800 focus:ring-2 focus:ring-green-500 focus:border-green-500"
                        >
                          <option value="">Seleccionar variación</option>
                          {product.variations.map((variation, idx) => (
                            <option key={idx} value={idx}>
                              {variation} - {catalog.currencySymbol}{(product.pricePerVariation[idx] || product.price).toFixed(2)}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    
                    <div className="flex items-center justify-between">
                      <div>
                        {product.hasVariablePricing && selectedVariation === undefined ? (
                          <span className="text-lg font-bold text-green-600">
                            <span className="text-sm font-normal text-gray-500">desde </span>
                            {catalog.currencySymbol}{product.displayPrice.toFixed(2)}
                          </span>
                        ) : (
                          <span className="text-lg font-bold text-green-600">
                            {catalog.currencySymbol}{currentPrice.toFixed(2)}
                          </span>
                        )}
                      </div>
                      
                      {whatsappLink ? (
                        <a
                          href={whatsappLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-2 bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                        >
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                          </svg>
                          Consultar
                        </a>
                      ) : (
                        <span className="text-sm text-gray-400">Sin WhatsApp</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      <footer className="bg-white border-t mt-12">
        <div className="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8">
          <p className="text-center text-sm text-gray-500">
            Catálogo de {catalog.businessName}
          </p>
        </div>
      </footer>
    </div>
  );
}
