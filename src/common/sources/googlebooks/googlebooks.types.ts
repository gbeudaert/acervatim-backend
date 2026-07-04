/**
 * Sous-ensemble de la réponse Google Books `GET /books/v1/volumes` réellement consommé :
 * on ne lit que les liens d'images du premier volume correspondant à l'ISBN.
 * Doc : https://developers.google.com/books/docs/v1/reference/volumes
 */
export interface GoogleBooksImageLinks {
  smallThumbnail?: string;
  thumbnail?: string;
  small?: string;
  medium?: string;
  large?: string;
  extraLarge?: string;
}

export interface GoogleBooksVolume {
  volumeInfo?: {
    imageLinks?: GoogleBooksImageLinks;
  };
}

export interface GoogleBooksVolumesResponse {
  items?: GoogleBooksVolume[];
}
