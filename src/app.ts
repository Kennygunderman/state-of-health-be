import express from 'express';
import workoutRoutes from './routes/workout.routes';
import exerciseRoutes from './routes/exercise.routes';
import migrationRoutes from './routes/migration.routes';
import userRoutes from './routes/user.routes';

const app = express();
app.use(express.json());
app.use('/api', workoutRoutes);
app.use('/api', exerciseRoutes);
app.use('/api', migrationRoutes);
app.use('/api', userRoutes);

export default app;
