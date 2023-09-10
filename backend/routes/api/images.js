const express = require('express');
const { Trip, Image, User, Bird } = require("../../db/schema");
const { verifyToken } = require("../../middleware/auth.js");
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const multerS3 = require('multer-s3');
const AWS = require('aws-sdk');

AWS.config.update({
    accessKeyId: process.env.AMAZON_ACCESS_KEY_ID,
    secretAccessKey: process.env.AMAZON_SECRET_ACCESS_KEY,
    region: process.env.AMAZON_REGION
});
const s3 = new AWS.S3();


const upload = multer({
    storage: multerS3({
        s3: s3,
        bucket: process.env.AMAZON_BUCKET_NAME,
        acl: 'private', // Set ACL to private
        metadata: function (req, file, cb) {
            cb(null, { fieldName: file.fieldname });
        },
        key: function (req, file, cb) {
            // Generate a unique file key using time for now and UUID
            const uniqueFileKey = Date.now().toString() + '-' + uuidv4() + '-' + file.originalname;
            cb(null, uniqueFileKey);
        }
    }),
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Not an image! Please upload an image.', false));
        }
    }
});

router.post('/upload', verifyToken, upload.single('photo'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded');
    }

    try {
        // Check if the user has an active trip
        const activeTrip = await Trip.findOne({ userId: req.user._id, isActive: true });

        if (!activeTrip) {
            return res.status(400).send('No active trip found. Please start a trip before uploading photos.');
        }

        if (!activeTrip.isEdugaming) {
            return res.status(403).send('EduGaming is not enabled for this trip. Cannot upload bird images.');
        }

        // Get the location and timestamp from the request
        const location = req.body.location ? JSON.parse(req.body.location) : null;
        const timestamp = req.body.timestamp || new Date();

        // Identify the bird using AI (for now, randomly select a bird)
        const birdCount = await Bird.countDocuments();
        const randomBird = await Bird.findOne().skip(Math.floor(Math.random() * birdCount));



        // Check if the identified bird matches the last specific bird goal
        const lastBirdSpecificGoal = activeTrip.birdSpecificGoals[activeTrip.birdSpecificGoals.length - 1];
        if (lastBirdSpecificGoal && lastBirdSpecificGoal.birdId.equals(randomBird._id)) {
            lastBirdSpecificGoal.status = 'success';
            const newLevel = Math.min(lastBirdSpecificGoal.level + 1, 3);  // increment level, max 3

            // get a random bird with rarity = level
            const randomBirdArrays = await Bird.aggregate([
                { $match: { rarity: newLevel } },
                { $sample: { size: 1 } }
            ]).exec();
            const bird = randomBirdArrays[0];

            const newSpecificGoal = {
                birdId: bird._id,
                birdName: bird.name,
                image: bird.images[0],
                level: newLevel
            };
            activeTrip.birdSpecificGoals.push(newSpecificGoal);
        }

        // Increase the bird count for the count-based goal and check if it matches the target
        const lastBirdCountGoal = activeTrip.birdCountGoals[activeTrip.birdCountGoals.length - 1];
        if (lastBirdCountGoal) {
            lastBirdCountGoal.birdsFound++;
            if (lastBirdCountGoal.birdsFound >= lastBirdCountGoal.level * 3) {
                lastBirdCountGoal.status = 'success';
                const newLevel = Math.min(lastBirdCountGoal.level + 1, 5);  // increment level, max 5
                const newCountGoal = {
                    count: newLevel * 3,
                    level: newLevel
                };
                activeTrip.birdCountGoals.push(newCountGoal);
            }
        }

        await activeTrip.save();

        // create image
        const newImage = new Image({
            s3Key: req.file.key,
            userId: req.user._id,
            location: location,
            timestamp: timestamp,
            birdId: randomBird._id
        });

        await newImage.save();

        // Update the trip's images array by pushing the new image's ObjectId
        activeTrip.images.push(newImage._id);
        await activeTrip.save();

        // Check if the identified bird is already in the user's myBirds array
        const user = await User.findById(req.user._id);
        if (!user.myBirds.includes(randomBird._id)) {
            user.myBirds.push(randomBird._id);
            await user.save();
        }

        res.status(201).send('Image uploaded successfully');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error uploading image');
    }
});

// Endpoint to get an image by key
router.get('/getImage/:key', verifyToken, async (req, res) => {
    try {
        const image = await Image.findOne({ s3Key: req.params.key, userId: req.user._id });

        if (!image) {
            return res.status(404).send('Image not found or you do not have permission to view it.');
        }

        // Generate a pre-signed URL for the image
        const url = s3.getSignedUrl('getObject', {
            Bucket: process.env.AMAZON_BUCKET_NAME,
            Key: image.s3Key,
            Expires: 60 * 30 //30 minutes access to the image
        });

        res.status(200).send(url);
    } catch (error) {
        res.status(500).send('Error retrieving image');
    }
});

module.exports = router;
