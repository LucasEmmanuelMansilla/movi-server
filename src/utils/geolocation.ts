/**
 * Utilidades para geolocalización y cálculo de distancias
 */

/**
 * Calcula la distancia en kilómetros entre dos coordenadas usando la fórmula de Haversine
 */
export function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Radio de la Tierra en kilómetros
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return distance;
}

function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * Intenta extraer coordenadas de una dirección si viene en formato JSON
 * Formato esperado: {"address": "...", "lat": 0.0, "lng": 0.0}
 */
export function parseAddressWithCoordinates(
  address: string
): { address: string; lat?: number; lng?: number } {
  try {
    const parsed = JSON.parse(address);
    if (typeof parsed === 'object' && parsed.address) {
      return {
        address: parsed.address,
        lat: typeof parsed.lat === 'number' ? parsed.lat : undefined,
        lng: typeof parsed.lng === 'number' ? parsed.lng : undefined,
      };
    }
  } catch {
    // Si no es JSON, devolver como dirección normal
  }

  return { address };
}

/**
 * Geocodifica una dirección usando Nominatim (OpenStreetMap)
 * Retorna las coordenadas si es posible, null si falla
 */
export async function geocodeAddress(
  address: string
): Promise<{ lat: number; lng: number } | null> {
  try {
    // Usar Nominatim de OpenStreetMap (gratuito, sin API key requerida)
    const encodedAddress = encodeURIComponent(address);
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodedAddress}&limit=1`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'MoviApp/1.0', // Nominatim requiere User-Agent
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    if (Array.isArray(data) && data.length > 0) {
      const result = data[0];
      const lat = parseFloat(result.lat);
      const lng = parseFloat(result.lon);

      if (!isNaN(lat) && !isNaN(lng)) {
        return { lat, lng };
      }
    }

    return null;
  } catch (error) {
    console.error('Error geocodificando dirección:', error);
    return null;
  }
}

/**
 * Encuentra usuarios (drivers) dentro de un radio determinado de una ubicación
 */
export function filterNearbyUsers<T extends { latitude?: number | null; longitude?: number | null }>(
  users: T[],
  centerLat: number,
  centerLng: number,
  radiusKm: number = 10
): T[] {
  return users.filter((user) => {
    if (
      user.latitude === null ||
      user.latitude === undefined ||
      user.longitude === null ||
      user.longitude === undefined
    ) {
      return false;
    }

    const distance = calculateDistance(
      centerLat,
      centerLng,
      user.latitude,
      user.longitude
    );

    return distance <= radiusKm;
  });
}

