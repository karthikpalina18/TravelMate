const express = require('express');
const router = express.Router();
const Booking = require('../models/Booking');
const Trip = require('../models/Trip');
const auth = require('../middleware/auth');
const { body, validationResult } = require('express-validator');

// Create a new booking
router.post('/', auth, [
  body('tripId').isMongoId().withMessage('Valid trip ID is required'),
  body('seatsBooked').isInt({ min: 1, max: 7 }).withMessage('Seats booked must be between 1 and 7'),
  body('pickupPoint.location').trim().isLength({ min: 1 }).withMessage('Pickup location is required'),
  body('pickupPoint.time').matches(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/).withMessage('Valid pickup time is required'),
  body('dropPoint.location').trim().isLength({ min: 1 }).withMessage('Drop location is required'),
  body('dropPoint.time').matches(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/).withMessage('Valid drop time is required'),
  body('paymentMethod').isIn(['cash', 'online', 'upi', 'card']).withMessage('Invalid payment method'),
  body('passengerDetails').isArray({ min: 1 }).withMessage('At least one passenger detail is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { tripId, seatsBooked, pickupPoint, dropPoint, paymentMethod, passengerDetails, specialRequests } = req.body;

    // Find the trip
    const trip = await Trip.findById(tripId);
    if (!trip) {
      return res.status(404).json({ message: 'Trip not found' });
    }

    // Check if trip is active
    if (trip.status !== 'active') {
      return res.status(400).json({ message: 'Trip is not available for booking' });
    }

    // Check if user is not the driver
    if (trip.driver.toString() === req.user.id) {
      return res.status(400).json({ message: 'You cannot book your own trip' });
    }

    // Check if seats are available
    if (!trip.hasAvailableSeats(seatsBooked)) {
      return res.status(400).json({ message: 'Not enough seats available' });
    }

    // Check if passenger details count matches seats booked
    if (passengerDetails.length !== seatsBooked) {
      return res.status(400).json({ message: 'Passenger details count must match seats booked' });
    }

    // Calculate total amount
    const totalAmount = trip.pricePerSeat * seatsBooked;

    // Create booking
    const booking = new Booking({
      trip: tripId,
      passenger: req.user.id,
      seatsBooked,
      totalAmount,
      pickupPoint,
      dropPoint,
      paymentMethod,
      passengerDetails,
      specialRequests
    });

    await booking.save();

    // Update trip with booking details
    trip.bookedSeats += seatsBooked;
    trip.passengers.push({
      user: req.user.id,
      seatsBooked,
      bookingDate: new Date()
    });
    trip.totalEarnings += totalAmount;
    
    await trip.save();

    // Generate OTP for the booking
    const otp = booking.generateOTP();
    await booking.save();

    const populatedBooking = await Booking.findById(booking._id)
      .populate('trip', 'from to departureDate departureTime driver vehicle')
      .populate('passenger', 'firstName lastName phone profileImage');

    res.status(201).json({
      booking: populatedBooking,
      otp,
      message: 'Booking created successfully'
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get booking details
router.get('/:id', auth, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id)
      .populate('trip', 'from to departureDate departureTime driver vehicle')
      .populate('passenger', 'firstName lastName phone profileImage');

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    // Check if user is the passenger or driver
    if (booking.passenger._id.toString() !== req.user.id && 
        booking.trip.driver.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to view this booking' });
    }

    res.json(booking);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update booking payment status
router.patch('/:id/payment', auth, [
  body('paymentStatus').isIn(['paid', 'failed']).withMessage('Invalid payment status'),
  body('transactionId').optional().trim().isLength({ min: 1 }).withMessage('Transaction ID is required for paid status')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { paymentStatus, transactionId } = req.body;

    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    // Check if user is the passenger
    if (booking.passenger.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to update this booking' });
    }

    // Update payment status
    booking.paymentStatus = paymentStatus;
    if (paymentStatus === 'paid' && transactionId) {
      booking.transactionId = transactionId;
      booking.bookingStatus = 'confirmed';
    } else if (paymentStatus === 'failed') {
      booking.bookingStatus = 'cancelled';
      
      // Release seats back to trip
      const trip = await Trip.findById(booking.trip);
      if (trip) {
        trip.bookedSeats -= booking.seatsBooked;
        trip.totalEarnings -= booking.totalAmount;
        trip.passengers = trip.passengers.filter(p => p.user.toString() !== req.user.id);
        await trip.save();
      }
    }

    await booking.save();

    res.json({ message: 'Payment status updated successfully', booking });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Cancel booking
router.patch('/:id/cancel', auth, [
  body('reason').optional().isLength({ max: 500 }).withMessage('Reason cannot exceed 500 characters')
], async (req, res) => {
  try {
    const { reason } = req.body;

    const booking = await Booking.findById(req.params.id).populate('trip');
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    // Check if user is the passenger
    if (booking.passenger.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to cancel this booking' });
    }

    if (booking.bookingStatus === 'cancelled') {
      return res.status(400).json({ message: 'Booking is already cancelled' });
    }

    // Calculate refund amount
    const refundAmount = booking.calculateRefund();

    // Update booking
    booking.bookingStatus = 'cancelled';
    booking.cancellationReason = reason;
    booking.cancelledBy = req.user.id;
    booking.cancelledAt = new Date();
    booking.refundAmount = refundAmount;

    await booking.save();

    // Update trip - release seats
    const trip = await Trip.findById(booking.trip._id);
    if (trip) {
      trip.bookedSeats -= booking.seatsBooked;
      trip.totalEarnings -= booking.totalAmount;
      trip.passengers = trip.passengers.filter(p => p.user.toString() !== req.user.id);
      await trip.save();
    }

    res.json({ 
      message: 'Booking cancelled successfully',
      booking,
      refundAmount 
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Verify OTP
router.post('/:id/verify-otp', auth, [
  body('otp').isLength({ min: 4, max: 4 }).withMessage('OTP must be 4 digits')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { otp } = req.body;

    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    // Check if user is authorized (passenger or driver)
    if (booking.passenger.toString() !== req.user.id) {
      const trip = await Trip.findById(booking.trip);
      if (!trip || trip.driver.toString() !== req.user.id) {
        return res.status(403).json({ message: 'Not authorized to verify this booking' });
      }
    }

    // Verify OTP
    if (booking.otp.code !== otp) {
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    // Check if OTP is expired (valid for 30 minutes)
    const otpAge = (new Date() - booking.otp.generatedAt) / (1000 * 60);
    if (otpAge > 30) {
      return res.status(400).json({ message: 'OTP has expired' });
    }

    // Mark OTP as verified
    booking.otp.verified = true;
    booking.bookingStatus = 'confirmed';
    await booking.save();

    res.json({ message: 'OTP verified successfully', booking });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Share contact details
router.post('/:id/share-contact', auth, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id)
      .populate('passenger', 'firstName lastName phone')
      .populate('trip');

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    const trip = await Trip.findById(booking.trip._id)
      .populate('driver', 'firstName lastName phone');

    // Check if user is passenger or driver
    let contactInfo = {};
    if (booking.passenger._id.toString() === req.user.id) {
      // Passenger requesting driver contact
      contactInfo = {
        name: trip.driver.firstName + ' ' + trip.driver.lastName,
        phone: trip.driver.phone
      };
      booking.driverContact = {
        ...contactInfo,
        sharedAt: new Date()
      };
    } else if (trip.driver._id.toString() === req.user.id) {
      // Driver requesting passenger contact
      contactInfo = {
        name: booking.passenger.firstName + ' ' + booking.passenger.lastName,
        phone: booking.passenger.phone
      };
      booking.passengerContact = {
        ...contactInfo,
        sharedAt: new Date()
      };
    } else {
      return res.status(403).json({ message: 'Not authorized to access contact details' });
    }

    await booking.save();

    res.json({ 
      message: 'Contact details shared successfully',
      contact: contactInfo 
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Rate booking
router.post('/:id/rate', auth, [
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5'),
  body('review').optional().isLength({ max: 500 }).withMessage('Review cannot exceed 500 characters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { rating, review } = req.body;

    const booking = await Booking.findById(req.params.id).populate('trip');
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    if (booking.bookingStatus !== 'completed') {
      return res.status(400).json({ message: 'Can only rate completed bookings' });
    }

    const trip = await Trip.findById(booking.trip._id);
    
    // Check if user is passenger or driver and rate accordingly
    if (booking.passenger.toString() === req.user.id) {
      // Passenger rating driver
      if (booking.rating.forDriver.rating) {
        return res.status(400).json({ message: 'You have already rated this driver' });
      }
      
      booking.rating.forDriver = { rating, review };
      
      // Update driver's overall rating
      const User = require('../models/User');
      const driver = await User.findById(trip.driver);
      if (driver) {
        const newCount = driver.rating.count + 1;
        const newAverage = ((driver.rating.average * driver.rating.count) + rating) / newCount;
        driver.rating.average = newAverage;
        driver.rating.count = newCount;
        await driver.save();
      }
      
    } else if (trip.driver.toString() === req.user.id) {
      // Driver rating passenger
      if (booking.rating.forPassenger.rating) {
        return res.status(400).json({ message: 'You have already rated this passenger' });
      }
      
      booking.rating.forPassenger = { rating, review };
      
      // Update passenger's overall rating
      const User = require('../models/User');
      const passenger = await User.findById(booking.passenger);
      if (passenger) {
        const newCount = passenger.rating.count + 1;
        const newAverage = ((passenger.rating.average * passenger.rating.count) + rating) / newCount;
        passenger.rating.average = newAverage;
        passenger.rating.count = newCount;
        await passenger.save();
      }
      
    } else {
      return res.status(403).json({ message: 'Not authorized to rate this booking' });
    }

    await booking.save();

    res.json({ message: 'Rating submitted successfully', booking });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get user's bookings
router.get('/user/bookings', auth, async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query;
    
    const query = { passenger: req.user.id };
    if (status) {
      query.bookingStatus = status;
    }

    const bookings = await Booking.find(query)
      .populate('trip', 'from to departureDate departureTime vehicle driver')
      .populate('trip.driver', 'firstName lastName profileImage rating')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Booking.countDocuments(query);

    res.json({
      bookings,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;