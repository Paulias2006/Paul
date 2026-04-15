// Shops Routes
const express = require('express');
const router = express.Router();
const Shop = require('../models/Shop');
const Product = require('../models/Product');
const { authenticateToken, optionalAuthToken } = require('../middleware/auth');

// Get all shops
router.get('/', optionalAuthToken, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const skip = parseInt(req.query.skip) || 0;
    const category = req.query.category;
    const search = req.query.search;
    const sort = req.query.sort || '-rating';

    const query = { isActive: true, deletedAt: null };

    if (category) query.category = category;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }

    const shops = await Shop.find(query)
      .select('-metadata')
      .limit(limit)
      .skip(skip)
      .sort(sort)
      .lean();

    const total = await Shop.countDocuments(query);

    return res.json({
      ok: true,
      shops,
      pagination: {
        total,
        limit,
        skip,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'failed',
      message: error.message,
    });
  }
});

// Get shop by ID
router.get('/:id', optionalAuthToken, async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.id).lean();

    if (!shop || shop.deletedAt) {
      return res.status(404).json({
        ok: false,
        error: 'shop_not_found',
        message: 'Shop not found',
      });
    }

    return res.json({
      ok: true,
      shop,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'failed',
      message: error.message,
    });
  }
});

// Get shop products
router.get('/:id/products', optionalAuthToken, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const skip = parseInt(req.query.skip) || 0;

    const products = await Product.find({
      shopId: req.params.id,
      isActive: true,
      deletedAt: null,
    })
      .limit(limit)
      .skip(skip)
      .lean()
      .sort({ createdAt: -1 });

    const total = await Product.countDocuments({
      shopId: req.params.id,
      isActive: true,
      deletedAt: null,
    });

    return res.json({
      ok: true,
      products,
      pagination: {
        total,
        limit,
        skip,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'failed',
      message: error.message,
    });
  }
});

// Create shop (sellers only)
router.post('/', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'seller' && req.user.role !== 'admin') {
      return res.status(403).json({
        ok: false,
        error: 'forbidden',
        message: 'Only sellers can create shops',
      });
    }

    const { name, description, category, phone, email, address, city, website, metadata } = req.body;

    if (!name || !category || !phone) {
      return res.status(400).json({
        ok: false,
        error: 'missing_fields',
        message: 'Name, category, and phone are required',
      });
    }

    // Check if shop already exists for this user
    const existingShop = await Shop.findOne({
      ownerId: req.user.userId,
      deletedAt: null,
    });

    if (existingShop && req.user.role !== 'admin') {
      return res.status(400).json({
        ok: false,
        error: 'shop_exists',
        message: 'You already have a shop',
      });
    }

    const shop = new Shop({
      ownerId: req.user.userId,
      name,
      description,
      category,
      phone,
      email,
      address,
      city,
      website,
      metadata: metadata || {},
    });

    await shop.save();

    return res.status(201).json({
      ok: true,
      message: 'Shop created successfully',
      shop: shop.toObject(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'creation_failed',
      message: error.message,
    });
  }
});

// Update shop
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.id);
    if (!shop) {
      return res.status(404).json({
        ok: false,
        error: 'shop_not_found',
        message: 'Shop not found',
      });
    }

    // Check authorization
    if (shop.ownerId.toString() !== req.user.userId && req.user.role !== 'admin') {
      return res.status(403).json({
        ok: false,
        error: 'forbidden',
        message: 'You can only update your own shop',
      });
    }

    const allowedUpdates = ['name', 'description', 'logo', 'coverImage', 'phone', 'email', 'address', 'city', 'website', 'isActive', 'metadata', 'commissionRate'];
    const update = {};

    allowedUpdates.forEach(field => {
      if (req.body[field] !== undefined) {
        update[field] = req.body[field];
      }
    });

    const updatedShop = await Shop.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true, runValidators: true }
    );

    return res.json({
      ok: true,
      message: 'Shop updated successfully',
      shop: updatedShop.toObject(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'update_failed',
      message: error.message,
    });
  }
});

// Delete shop (soft delete)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.id);
    if (!shop) {
      return res.status(404).json({
        ok: false,
        error: 'shop_not_found',
        message: 'Shop not found',
      });
    }

    // Check authorization
    if (shop.ownerId.toString() !== req.user.userId && req.user.role !== 'admin') {
      return res.status(403).json({
        ok: false,
        error: 'forbidden',
        message: 'You can only delete your own shop',
      });
    }

    shop.deletedAt = new Date();
    shop.isActive = false;
    await shop.save();

    return res.json({
      ok: true,
      message: 'Shop deleted successfully',
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'deletion_failed',
      message: error.message,
    });
  }
});

module.exports = router;
