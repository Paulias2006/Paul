// Products Routes
const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const { authenticateToken, optionalAuthToken } = require('../middleware/auth');

// Get all products with filters
router.get('/', optionalAuthToken, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const skip = parseInt(req.query.skip) || 0;
    const category = req.query.category;
    const shopId = req.query.shop;
    const minPrice = req.query.minPrice;
    const maxPrice = req.query.maxPrice;
    const search = req.query.search;
    const sort = req.query.sort || '-createdAt';

    const query = { isActive: true, deletedAt: null };

    if (category) query.category = category;
    if (shopId) query.shopId = shopId;
    if (minPrice || maxPrice) {
      query.price = {};
      if (minPrice) query.price.$gte = parseFloat(minPrice);
      if (maxPrice) query.price.$lte = parseFloat(maxPrice);
    }
    if (search) {
      query.$text = { $search: search };
    }

    const products = await Product.find(query)
      .populate('shopId', 'name logo rating')
      .limit(limit)
      .skip(skip)
      .sort(sort)
      .lean();

    const total = await Product.countDocuments(query);

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

// Get product by ID
router.get('/:id', optionalAuthToken, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id)
      .populate('shopId', 'name logo rating phone')
      .lean();

    if (!product || product.deletedAt) {
      return res.status(404).json({
        ok: false,
        error: 'product_not_found',
        message: 'Product not found',
      });
    }

    return res.json({
      ok: true,
      product,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'failed',
      message: error.message,
    });
  }
});

// Create product (sellers only)
router.post('/', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'seller' && req.user.role !== 'admin') {
      return res.status(403).json({
        ok: false,
        error: 'forbidden',
        message: 'Only sellers can create products',
      });
    }

    const { name, description, price, category, shopId, images, stock, metadata } = req.body;

    if (!name || !price || !category || !shopId) {
      return res.status(400).json({
        ok: false,
        error: 'missing_fields',
        message: 'Name, price, category, and shopId are required',
      });
    }

    const product = new Product({
      name,
      description,
      price,
      category,
      shopId,
      images: images || [],
      stock: stock || 0,
      metadata: metadata || {},
    });

    await product.save();

    return res.status(201).json({
      ok: true,
      message: 'Product created successfully',
      product: product.toObject(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'creation_failed',
      message: error.message,
    });
  }
});

// Update product
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({
        ok: false,
        error: 'product_not_found',
        message: 'Product not found',
      });
    }

    // Check authorization
    if (product.shopId.toString() !== req.body.shopId && req.user.role !== 'admin') {
      return res.status(403).json({
        ok: false,
        error: 'forbidden',
        message: 'You can only update your own products',
      });
    }

    const allowedUpdates = ['name', 'description', 'price', 'category', 'images', 'stock', 'isActive', 'metadata'];
    const update = {};

    allowedUpdates.forEach(field => {
      if (req.body[field] !== undefined) {
        update[field] = req.body[field];
      }
    });

    const updatedProduct = await Product.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true, runValidators: true }
    );

    return res.json({
      ok: true,
      message: 'Product updated successfully',
      product: updatedProduct.toObject(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'update_failed',
      message: error.message,
    });
  }
});

// Delete product (soft delete)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({
        ok: false,
        error: 'product_not_found',
        message: 'Product not found',
      });
    }

    // Check authorization
    if (product.shopId.toString() !== req.body.shopId && req.user.role !== 'admin') {
      return res.status(403).json({
        ok: false,
        error: 'forbidden',
        message: 'You can only delete your own products',
      });
    }

    product.deletedAt = new Date();
    product.isActive = false;
    await product.save();

    return res.json({
      ok: true,
      message: 'Product deleted successfully',
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
