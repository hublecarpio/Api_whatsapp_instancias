import { Router, Response } from 'express';
import crypto from 'crypto';
import prisma from '../services/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { sendEmail } from '../services/emailService.js';

const router = Router();

router.use(authMiddleware);

router.post('/invite', async (req: AuthRequest, res: Response) => {
  try {
    const { email, businessId } = req.body;
    
    if (!email || !businessId) {
      return res.status(400).json({ error: 'email and businessId are required' });
    }
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: 'This email is already registered' });
    }
    
    const existingInvitation = await prisma.advisorInvitation.findUnique({
      where: { email_businessId: { email, businessId } }
    });
    
    if (existingInvitation && !existingInvitation.acceptedAt) {
      return res.status(400).json({ error: 'Invitation already sent to this email' });
    }
    
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    
    await prisma.advisorInvitation.upsert({
      where: { email_businessId: { email, businessId } },
      update: { token, expiresAt, acceptedAt: null },
      create: {
        email,
        token,
        invitedById: req.userId!,
        businessId,
        expiresAt
      }
    });
    
    const inviteUrl = `${process.env.FRONTEND_URL || 'http://localhost:5000'}/advisor-signup?token=${token}`;
    
    await sendEmail(
      email,
      `Invitacion para ser asesor en ${business.name}`,
      `
        <h2>Has sido invitado como asesor</h2>
        <p>Has sido invitado a unirte como asesor en <strong>${business.name}</strong>.</p>
        <p>Haz clic en el siguiente enlace para crear tu cuenta:</p>
        <p><a href="${inviteUrl}" style="background: #6366f1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block;">Aceptar Invitacion</a></p>
        <p>Este enlace expira en 7 dias.</p>
      `
    );
    
    res.json({ message: 'Invitation sent successfully' });
  } catch (error: any) {
    console.error('Invite advisor error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/invitations/:businessId', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const invitations = await prisma.advisorInvitation.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' }
    });
    
    res.json(invitations);
  } catch (error: any) {
    console.error('Get invitations error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/invitation/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    
    const invitation = await prisma.advisorInvitation.findUnique({
      where: { id },
      include: { business: true }
    });
    
    if (!invitation || invitation.business.userId !== req.userId) {
      return res.status(404).json({ error: 'Invitation not found' });
    }
    
    await prisma.advisorInvitation.delete({ where: { id } });
    
    res.json({ message: 'Invitation cancelled' });
  } catch (error: any) {
    console.error('Cancel invitation error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/team/:businessId', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const advisors = await prisma.user.findMany({
      where: {
        parentUserId: req.userId,
        role: 'ASESOR'
      },
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
        _count: {
          select: { contactAssignments: true }
        }
      }
    });
    
    res.json(advisors);
  } catch (error: any) {
    console.error('Get team error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/team/:advisorId', async (req: AuthRequest, res: Response) => {
  try {
    const { advisorId } = req.params;
    
    const advisor = await prisma.user.findFirst({
      where: {
        id: advisorId,
        parentUserId: req.userId,
        role: 'ASESOR'
      }
    });
    
    if (!advisor) {
      return res.status(404).json({ error: 'Advisor not found' });
    }
    
    await prisma.user.delete({ where: { id: advisorId } });
    
    res.json({ message: 'Advisor removed' });
  } catch (error: any) {
    console.error('Remove advisor error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/assign', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, contactPhone, advisorId } = req.body;
    
    if (!businessId || !contactPhone || !advisorId) {
      return res.status(400).json({ error: 'businessId, contactPhone and advisorId are required' });
    }
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const advisor = await prisma.user.findFirst({
      where: {
        id: advisorId,
        parentUserId: req.userId,
        role: 'ASESOR'
      }
    });
    
    if (!advisor) {
      return res.status(404).json({ error: 'Advisor not found' });
    }
    
    await prisma.contactAssignment.upsert({
      where: { businessId_contactPhone: { businessId, contactPhone } },
      update: { userId: advisorId },
      create: { businessId, contactPhone, userId: advisorId }
    });
    
    res.json({ message: 'Contact assigned successfully' });
  } catch (error: any) {
    console.error('Assign contact error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/assign/:businessId/:contactPhone', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, contactPhone } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    await prisma.contactAssignment.deleteMany({
      where: { businessId, contactPhone }
    });
    
    res.json({ message: 'Assignment removed' });
  } catch (error: any) {
    console.error('Remove assignment error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/assignments/:businessId', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const assignments = await prisma.contactAssignment.findMany({
      where: { businessId },
      include: {
        user: {
          select: { id: true, name: true, email: true }
        }
      }
    });
    
    res.json(assignments);
  } catch (error: any) {
    console.error('Get assignments error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/my-business', async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { role: true, parentUserId: true }
    });
    
    if (!user || user.role !== 'ASESOR' || !user.parentUserId) {
      return res.status(403).json({ error: 'Only advisors can access this endpoint' });
    }
    
    const assignments = await prisma.contactAssignment.findMany({
      where: { userId: req.userId },
      select: { businessId: true }
    });
    
    const businessIds = [...new Set(assignments.map(a => a.businessId))];
    
    if (businessIds.length === 0) {
      return res.json([]);
    }
    
    const businesses = await prisma.business.findMany({
      where: { id: { in: businessIds } },
      select: {
        id: true,
        name: true,
        description: true,
        businessObjective: true,
        _count: {
          select: {
            contactAssignments: {
              where: { userId: req.userId }
            }
          }
        }
      }
    });
    
    res.json(businesses.map(b => ({
      ...b,
      assignedContactsCount: b._count.contactAssignments
    })));
  } catch (error: any) {
    console.error('Get advisor business error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/my-contacts/:businessId', async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.params;
    
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { role: true, parentUserId: true }
    });
    
    if (!user || user.role !== 'ASESOR') {
      return res.status(403).json({ error: 'Only advisors can access this endpoint' });
    }
    
    const assignments = await prisma.contactAssignment.findMany({
      where: { 
        userId: req.userId,
        businessId 
      },
      select: { contactPhone: true, assignedAt: true }
    });
    
    res.json(assignments);
  } catch (error: any) {
    console.error('Get advisor contacts error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
