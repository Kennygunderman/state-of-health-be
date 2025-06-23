import express from 'express';
import workoutRoutes from './routes/workout.routes';
import exerciseRoutes from './routes/exercise.routes';
import migrationRoutes from './routes/migration.routes';
import userRoutes from './routes/user.routes';
import { authenticateFirebaseToken } from './middleware/auth';

const app = express();
app.use(express.json());

// Unprotected user routes
app.use('/api', userRoutes);

// Protected routes
app.use(authenticateFirebaseToken);
app.use('/api', workoutRoutes);
app.use('/api', exerciseRoutes);
app.use('/api', migrationRoutes);

export default app;
