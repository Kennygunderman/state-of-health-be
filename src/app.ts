import express from 'express';
import workoutRoutes from './routes/workout.routes';
import migrationRoutes from './routes/migration.routes';

const app = express();
app.use(express.json());
app.use('/api', workoutRoutes);
// app.use('/api', migrationRoutes);
export default app;
