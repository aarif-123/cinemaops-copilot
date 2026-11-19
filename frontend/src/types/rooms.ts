export interface CinemaRoom {
  id: string;
  name: string;
  screenType: string;
  time: string;
  movie: string;
  totalSeats: number;
  soldSeats: number;
  quarantinedSeats: number;
  activeHolds: number;
  pendingApprovals: number;
  status: 'incident' | 'normal' | 'cleaning';
  incidentText?: string;
}

export const CINEMA_ROOMS: CinemaRoom[] = [
  {
    id: 'screen-4',
    name: 'Screen 4',
    screenType: 'IMAX Laser',
    time: '7:30 PM',
    movie: 'Interstellar (10th Anniv)',
    totalSeats: 140,
    soldSeats: 72,
    quarantinedSeats: 0,
    activeHolds: 3,
    pendingApprovals: 1,
    status: 'incident',
    incidentText: 'HVAC Duct Leak · Rows E–F',
  },
  {
    id: 'screen-1',
    name: 'Screen 1',
    screenType: 'Dolby Cinema',
    time: '8:00 PM',
    movie: 'Dune: Part Two',
    totalSeats: 160,
    soldSeats: 128,
    quarantinedSeats: 0,
    activeHolds: 2,
    pendingApprovals: 0,
    status: 'normal',
  },
  {
    id: 'screen-2',
    name: 'Screen 2',
    screenType: 'VIP Recliner Lounge',
    time: '7:00 PM',
    movie: 'Oppenheimer',
    totalSeats: 80,
    soldSeats: 64,
    quarantinedSeats: 4,
    activeHolds: 0,
    pendingApprovals: 0,
    status: 'normal',
  },
  {
    id: 'screen-3',
    name: 'Screen 3',
    screenType: 'Standard 4K',
    time: '8:15 PM',
    movie: 'Gladiator II',
    totalSeats: 120,
    soldSeats: 45,
    quarantinedSeats: 0,
    activeHolds: 1,
    pendingApprovals: 0,
    status: 'normal',
  },
];
