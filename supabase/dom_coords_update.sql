-- =============================================================
-- dom_coords_update.sql
-- =============================================================
-- Dom şubesinin koordinatları güncellendi.
-- Eski: 50.94032812642508, 6.939643179081483
-- Yeni: 50.942212123059406, 6.955781214751541
--
-- branch_locations tek satırı UPDATE et. Geofence ve diğer alanlar
-- aynı kalır. Idempotent — birden çok kez çalıştırılabilir.
-- =============================================================

UPDATE public.branch_locations
   SET latitude  = 50.942212123059406,
       longitude = 6.955781214751541,
       updated_at = NOW()
 WHERE branch = 'Dom';
