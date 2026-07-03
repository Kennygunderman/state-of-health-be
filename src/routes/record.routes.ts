import { Router } from 'express';
import { getRecords } from '../controllers/record.controller';

const router = Router();

router.get('/records', getRecords);

export default router;
