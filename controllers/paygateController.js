const paygateConfig = require('../config/paygate');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const logger = require('../middleware/logger');

// @desc    Initiate deposit
// @route   POST /api/payment/deposit
// @access  Private
const initiateDeposit = async (req, res) => {
  try {
    const { amount, method, phoneNumber } = req.body;
    const userId = req.user._id;

    // Validate input
    if (!amount || !method || !phoneNumber) {
      return res.status(400).json({
        success: false,
        message: 'Amount, method, and phone number are required'
      });
    }

    // Validate amount
    if (amount < 100 || amount > 1000000) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be between 100 and 1,000,000 XOF'
      });
    }

    // Validate payment method
    const validMethods = ['flooz', 'tmoney'];
    if (!validMethods.includes(method.toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment method. Use flooz or tmoney'
      });
    }

    // Generate unique identifier
    const identifier = `DEP_${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Calculate fees
    const fees = paygateConfig.calculateFees(amount, method.toLowerCase());

    // Initiate payment with PayGate
    const paymentResult = await paygateConfig.initiatePayment(
      phoneNumber,
      amount,
      `Deposit to FinPay wallet - ${req.user.name}`,
      identifier,
      method.toUpperCase()
    );

    if (!paymentResult.success) {
      logger.error('PayGate deposit initiation failed:', paymentResult.error);
      return res.status(400).json({
        success: false,
        message: 'Failed to initiate payment',
        error: paymentResult.error
      });
    }

    // Create transaction record
    const transaction = new Transaction({
      sender: userId,
      type: 'deposit',
      amount: amount,
      fees: fees,
      paymentMethod: method.toLowerCase(),
      status: 'pending',
      description: `Deposit via ${method.toUpperCase()}`,
      externalReference: paymentResult.data.tx_reference,
      internalReference: identifier,
      metadata: {
        phoneNumber: phoneNumber,
        paygateTxRef: paymentResult.data.tx_reference
      }
    });

    await transaction.save();

    logger.info(`Deposit initiated: ${identifier} - Amount: ${amount} XOF - Method: ${method}`);

    res.json({
      success: true,
      message: 'Deposit initiated successfully',
      data: {
        transactionId: transaction._id,
        txReference: paymentResult.data.tx_reference,
        identifier: identifier,
        amount: amount,
        fees: fees,
        status: 'pending'
      }
    });

  } catch (error) {
    logger.error('Initiate deposit error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error initiating deposit'
    });
  }
};

// @desc    Check deposit status
// @route   GET /api/payment/paygate/status/:transactionId
// @access  Private
const checkDepositStatus = async (req, res) => {
  try {
    const { transactionId } = req.params;
    const userId = req.user._id;

    // Find transaction
    const transaction = await Transaction.findOne({
      _id: transactionId,
      sender: userId,
      type: 'deposit'
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    // Check status with PayGate
    const statusResult = await paygateConfig.checkPaymentStatus(transaction.externalReference);

    if (!statusResult.success) {
      return res.status(400).json({
        success: false,
        message: 'Failed to check payment status',
        error: statusResult.error
      });
    }

    const paygateStatus = statusResult.data.status;
    let newStatus = transaction.status;

    // Map PayGate status to our status
    switch (paygateStatus) {
      case 0: // Payment successful
        newStatus = 'completed';
        break;
      case 2: // In progress
        newStatus = 'pending';
        break;
      case 4: // Expired
        newStatus = 'expired';
        break;
      case 6: // Cancelled
        newStatus = 'cancelled';
        break;
      default:
        newStatus = 'pending';
    }

    // Update transaction if status changed
    if (newStatus !== transaction.status) {
      transaction.status = newStatus;
      transaction.completedAt = newStatus === 'completed' ? new Date() : null;

      // If completed, update wallet balance
      if (newStatus === 'completed') {
        const wallet = await Wallet.findByUser(userId);
        if (wallet) {
          wallet.balance += transaction.amount;
          await wallet.save();
        }
      }

      await transaction.save();
      logger.info(`Deposit status updated: ${transactionId} - Status: ${newStatus}`);
    }

    res.json({
      success: true,
      data: {
        transactionId: transaction._id,
        status: transaction.status,
        amount: transaction.amount,
        paygateStatus: paygateStatus,
        paygateData: statusResult.data
      }
    });

  } catch (error) {
    logger.error('Check deposit status error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error checking deposit status'
    });
  }
};

// @desc    Initiate withdrawal
// @route   POST /api/payment/withdraw
// @access  Private
const initiateWithdrawal = async (req, res) => {
  try {
    const { amount, method, phoneNumber } = req.body;
    const userId = req.user._id;

    // Validate input
    if (!amount || !method || !phoneNumber) {
      return res.status(400).json({
        success: false,
        message: 'Amount, method, and phone number are required'
      });
    }

    // Validate amount
    if (amount < 100 || amount > 1000000) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be between 100 and 1,000,000 XOF'
      });
    }

    // Validate payment method
    const validMethods = ['flooz', 'tmoney'];
    if (!validMethods.includes(method.toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment method. Use flooz or tmoney'
      });
    }

    // Check wallet balance
    const wallet = await Wallet.findByUser(userId);
    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: 'Wallet not found'
      });
    }

    // Calculate fees
    const fees = paygateConfig.calculateFees(amount, method.toLowerCase());
    const totalAmount = amount + fees;

    if (wallet.balance < totalAmount) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient balance',
        required: totalAmount,
        available: wallet.balance
      });
    }

    // Generate unique identifier
    const identifier = `WITHDRAW_${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // For withdrawals, we need to handle this differently
    // PayGate typically handles deposits, for withdrawals we might need to implement a different flow
    // For now, we'll create a pending transaction and handle it manually or through PayGate's disbursement API

    // Create transaction record
    const transaction = new Transaction({
      sender: userId,
      type: 'withdrawal',
      amount: amount,
      fees: fees,
      paymentMethod: method.toLowerCase(),
      status: 'pending',
      description: `Withdrawal via ${method.toUpperCase()}`,
      internalReference: identifier,
      metadata: {
        phoneNumber: phoneNumber,
        withdrawalRequest: true
      }
    });

    await transaction.save();

    // Deduct from wallet immediately (could be refunded if withdrawal fails)
    wallet.balance -= totalAmount;
    await wallet.save();

    logger.info(`Withdrawal initiated: ${identifier} - Amount: ${amount} XOF - Method: ${method}`);

    res.json({
      success: true,
      message: 'Withdrawal request submitted successfully',
      data: {
        transactionId: transaction._id,
        identifier: identifier,
        amount: amount,
        fees: fees,
        totalDeducted: totalAmount,
        status: 'pending',
        note: 'Withdrawal requests are processed manually. You will be notified once completed.'
      }
    });

  } catch (error) {
    logger.error('Initiate withdrawal error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error initiating withdrawal'
    });
  }
};

// @desc    Get payment methods
// @route   GET /api/payment/methods
// @access  Public
const getPaymentMethods = async (req, res) => {
  try {
    const methods = Object.keys(paygateConfig.paymentMethods).map(key => ({
      code: paygateConfig.paymentMethods[key].code,
      name: paygateConfig.paymentMethods[key].name,
      description: paygateConfig.paymentMethods[key].description,
      minAmount: paygateConfig.paymentMethods[key].minAmount,
      maxAmount: paygateConfig.paymentMethods[key].maxAmount,
      fees: paygateConfig.paymentMethods[key].fees
    }));

    res.json({
      success: true,
      data: { methods }
    });
  } catch (error) {
    logger.error('Get payment methods error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Handle PayGate webhook
// @route   POST /api/payment/paygate/webhook
// @access  Public
const handleWebhook = async (req, res) => {
  try {
    const {
      tx_reference,
      identifier,
      payment_reference,
      amount,
      datetime,
      payment_method,
      phone_number
    } = req.body;

    logger.info('PayGate webhook received:', req.body);

    // Find transaction by identifier
    const transaction = await Transaction.findOne({ internalReference: identifier });

    if (!transaction) {
      logger.warn(`Transaction not found for identifier: ${identifier}`);
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    // Update transaction
    transaction.status = 'completed';
    transaction.externalReference = tx_reference;
    transaction.completedAt = new Date(datetime);
    transaction.metadata = {
      ...transaction.metadata,
      paymentReference: payment_reference,
      paymentMethod: payment_method,
      phoneNumber: phone_number,
      webhookReceived: true
    };

    await transaction.save();

    // Update wallet balance
    if (transaction.type === 'deposit') {
      const wallet = await Wallet.findByUser(transaction.sender);
      if (wallet) {
        wallet.balance += transaction.amount;
        await wallet.save();
      }
    }

    logger.info(`Transaction completed via webhook: ${transaction._id}`);

    res.json({ success: true, message: 'Webhook processed successfully' });

  } catch (error) {
    logger.error('Webhook processing error:', error);
    res.status(500).json({
      success: false,
      message: 'Webhook processing failed'
    });
  }
};

module.exports = {
  initiateDeposit,
  checkDepositStatus,
  initiateWithdrawal,
  getPaymentMethods,
  handleWebhook,
};
