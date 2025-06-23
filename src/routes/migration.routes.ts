import { Router } from 'express';
import { migrateAllUserData } from '../services/migration.service';

const router = Router();

// router.get('/migrate', async (req, res) => {
//     try {
//         const result = await migrateAllUserData();
//         res.json(result);
//     } catch (error) {
//         console.error('Migration error:', error);
//         res.status(500).json({
//             success: false,
//             message: 'Migration failed',
//             error: error instanceof Error ? error.message : 'Unknown error'
//         });
//     }
// });

export default router;
